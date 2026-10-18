"""Constrain Docker operations to this run; container names are reusable."""
import json
import subprocess

LABEL='io.nelcota.stress.run'
LOG_PROFILE={'driver':'local','max_size_bytes':8*1024*1024,'max_files':2}
CONTAINER_FORMAT='{"id":{{json .Id}},"labels":{{json .Config.Labels}}}'


def container_id(name,identity):
    result=subprocess.run(['docker','inspect','--format',CONTAINER_FORMAT,name],capture_output=True,text=True,timeout=10)
    if result.returncode:
        return None
    value=json.loads(result.stdout)
    if (value.get('labels') or {}).get(LABEL)!=identity:
        return None
    identifier=value.get('id')
    if not isinstance(identifier,str) or len(identifier)!=64 or any(char not in '0123456789abcdef' for char in identifier):
        raise RuntimeError('Invalid owned container identity')
    return identifier


class OwnedDocker:
    def __init__(self,identity,raw):
        self.identity,self.raw=identity,raw

    def require(self,name):
        identifier=container_id(str(name),self.identity)
        if identifier is None:
            raise RuntimeError('Docker resource is absent or belongs to another run')
        return identifier

    def volume(self,name,missing_ok=False):
        try:
            value=json.loads(self.raw('volume','inspect',name))[0]
        except RuntimeError as error:
            if missing_ok and 'no such volume' in str(error).lower():
                return False
            raise
        if (value.get('Labels') or {}).get(LABEL)!=self.identity:
            raise RuntimeError('Docker volume belongs to another run; refuse to mount or remove it')
        return True

    def __call__(self,*arguments,**keywords):
        args=list(map(str,arguments))
        command=args[0]
        if command=='run':
            if any(value.split('=',1)[0] in ('--log-driver','--log-opt') for value in args):
                raise ValueError('Owned fixtures require the bounded campaign log policy')
            args[1:1]=['--log-driver','local','--log-opt','max-size=8m','--log-opt','max-file=2']
        if command=='volume' and args[1]=='create':
            self.volume(args[-1],missing_ok=True)
            result=self.raw(*args,**keywords)
            self.volume(args[-1])
            return result
        if command=='volume' and args[1]=='rm':
            self.volume(args[-1])
        if command in ('rm','stop','start','kill','pause','unpause','update','logs','inspect'):
            args[-1]=self.require(args[-1])
        if command=='exec':
            index=1
            while index<len(args) and args[index].startswith('-'):
                if args[index] in ('-e','--env','-u','--user','-w','--workdir'):
                    index+=1
                index+=1
            if index>=len(args):
                raise ValueError('Missing owned exec target')
            args[index]=self.require(args[index])
        if command=='stats':
            for index,value in enumerate(args):
                if value.startswith(self.identity+'-'):
                    args[index]=self.require(value)
        if command=='cp':
            for index,value in enumerate(args):
                if value.startswith(self.identity+'-') and ':' in value:
                    name,path=value.split(':',1)
                    args[index]=self.require(name)+':'+path
        return self.raw(*args,**keywords)
