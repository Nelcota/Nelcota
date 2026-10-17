"""Validate the already measured seven browser heap/DOM owner plateaus."""
import math

PHASES=['baseline',*['navigation-rest-'+str(index) for index in range(1,6)],'final-disposed']
FIELDS={'documents','nodes','listeners','heap_bytes'}


def require(condition):
    if not condition:
        raise ValueError('Invalid bounded browser owner evidence')


def complete(values):
    require(isinstance(values,list) and len(values)==len(PHASES))
    previous=0
    for expected,row in zip(PHASES,values):
        require(isinstance(row,dict) and set(row)=={'phase','seconds_since_auth','pages'} and row['phase']==expected)
        now=row['seconds_since_auth']
        require(type(now) in {int,float} and math.isfinite(now) and previous<=now<=1260)
        previous=now
        require(isinstance(row['pages'],list) and len(row['pages'])==3)
        for page in row['pages']:
            require(isinstance(page,dict) and set(page)==FIELDS
                    and all(type(page[key]) is int and 0<=page[key]<2**31 for key in ['documents','nodes','listeners'])
                    and page['documents']>0 and page['nodes']>0
                    and type(page['heap_bytes']) in {int,float} and math.isfinite(page['heap_bytes'])
                    and 0<page['heap_bytes']<=512*1024**2)
    deltas=[]
    for initial,final in zip(values[0]['pages'],values[-1]['pages']):
        delta={key:final[key]-initial[key] for key in sorted(FIELDS)}
        require(delta['heap_bytes']<=8*1024**2 and delta['nodes']<=250 and delta['listeners']<=32)
        deltas.append(delta)
    return {'scope':'Three real Chromium tabs after explicit garbage collection; baseline,fivepressure/rest cycles and final SDK disposal. Same existing8MiB/250node/32listener growth gates, not an absence-of-all-leaks claim.',
            'plateaus':values,'final_minus_baseline_per_tab':deltas}
