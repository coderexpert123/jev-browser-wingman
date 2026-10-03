import json
d=json.load(open('publish-merged.json'))
key='mcp__jev-browser-wingman__browse_step'
forced=[r for r in d['runs'] if r['route']!='playwright']
bad=[(r['task'],r['typesafe']['calls'],r['tool_use_counts'].get(key,0)) for r in forced if r['typesafe']['calls']!=r['tool_use_counts'].get(key,0)]
print('forced cells checked:',len(forced),'mismatches:',len(bad))
