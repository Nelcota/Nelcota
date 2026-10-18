"""Require stable loopback-only publication across owned container restarts."""
import json


def published_port(owned,container,private_port,expected):
    if isinstance(expected,bool) or not isinstance(expected,int) or not 1<=expected<=65535:
        raise ValueError('Invalid expected owned listener')
    state=json.loads(owned('inspect',container))[0]
    mappings=state['NetworkSettings']['Ports'].get(str(private_port)+'/tcp')
    if not isinstance(mappings,list) or len(mappings)!=1 or mappings[0].get('HostIp')!='127.0.0.1':
        raise RuntimeError('Owned fixture publication is missing, ambiguous or not loopback-only')
    actual=mappings[0].get('HostPort')
    if not isinstance(actual,str) or not actual.isascii() or not actual.isdecimal() or int(actual)!=expected:
        raise RuntimeError('Owned fixture port changed across its lifecycle')
    return expected
