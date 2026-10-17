"""Drop a real upstream HTTP reply before the downstream HTTP client sees it."""
import http.client
import secrets
import socket
import threading
import time


def discard_reply(forward,path,body,authorization):
    if not isinstance(body,bytes) or len(body)>2048 or path!='/rest/v1/rpc/stress_transfer':
        raise ValueError('Lost-reply probe escaped its bounded fixture RPC')
    if not isinstance(authorization,str) or not authorization.isascii() or len(authorization)>2048 or '\r' in authorization or '\n' in authorization:
        raise ValueError('Invalid fixture authorization envelope')
    client,intermediary=socket.socketpair()
    client.settimeout(12)
    intermediary.settimeout(2)
    result={}
    errors=[]
    def exchange():
        try:
            with intermediary.makefile('rb') as stream:
                first=stream.readline(8193)
                if first!=b'POST '+path.encode()+b' HTTP/1.1\r\n':
                    raise RuntimeError('Unexpected downstream fault request')
                total=len(first)
                headers={}
                complete=False
                for _ in range(32):
                    line=stream.readline(8193)
                    total+=len(line)
                    if total>8192 or not line:raise RuntimeError('Fault request exceeded its header budget')
                    if line==b'\r\n':
                        complete=True
                        break
                    key,value=line.decode('ascii').split(':',1)
                    key=key.lower()
                    if key in headers:raise RuntimeError('Ambiguous fault request headers')
                    headers[key]=value.strip()
                if not complete or not secrets.compare_digest(headers.get('authorization',''),authorization) or headers.get('content-length')!=str(len(body)) or stream.read(len(body))!=body:
                    raise RuntimeError('Forwarded operation differs from the downstream request')
                status,response_body=forward()
                if isinstance(status,bool) or not isinstance(status,int) or not 100<=status<=599 or not isinstance(response_body,bytes) or len(response_body)>1024*1024:
                    raise ValueError('Invalid upstream fault response')
                result.update({'status':status,'body':response_body,'backend_reply_monotonic':time.monotonic(),'commit_response_observed':200<=status<300})
        except Exception as error:
            errors.append(error)
        finally:
            result['disconnect_monotonic']=time.monotonic()
            try:intermediary.shutdown(socket.SHUT_RDWR)
            except OSError:pass
            intermediary.close()
    thread=threading.Thread(target=exchange,name='stress-lost-reply',daemon=True)
    thread.start()
    connection=http.client.HTTPConnection('owned-fault.invalid',timeout=12)
    connection.sock=client  # A private OS stream; no downstream DNS/network dial.
    lost=False
    try:
        connection.request('POST',path,body=body,headers={'Authorization':authorization,'Content-Type':'application/json'})
        try:
            connection.getresponse()
        except (http.client.RemoteDisconnected,ConnectionResetError):
            lost=True
            result['client_disconnect_monotonic']=time.monotonic()
    finally:
        connection.close()
        thread.join(timeout=10)
        if thread.is_alive():
            intermediary.close()
            raise RuntimeError('Lost-reply intermediary retained a task')
    if errors:raise errors[0]
    if not lost or not result.get('backend_reply_monotonic') or not result['backend_reply_monotonic']<=result['disconnect_monotonic']<=result['client_disconnect_monotonic']:
        raise RuntimeError('Lost-reply ordering was not demonstrated')
    result.update({'client_saw_response':False,'downstream_transport':'HTTP over a private owned socketpair; upstream uses the actual project HTTP endpoint','intermediary_task_stopped':True})
    return result
