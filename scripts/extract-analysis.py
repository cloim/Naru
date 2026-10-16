"""Read selected ASAR files without executing shipped application code."""
import json,struct,pathlib,hashlib
target=pathlib.Path('C:/Program Files/External Engine/resources/app.asar')
out=pathlib.Path('evidence/shipped');out.mkdir(parents=True,exist_ok=True)
with target.open('rb') as f:
    _,header_size=struct.unpack('<II',f.read(8));header=f.read(header_size)
    json_size=struct.unpack('<I',header[4:8])[0];tree=json.loads(header[8:8+json_size])
    for name in ['package.json','dist/app/background.js']:
        node=tree
        for part in name.split('/'):node=node['files'][part]
        f.seek(8+header_size+int(node['offset']));blob=f.read(node['size'])
        dest=out/pathlib.Path(name).name;dest.write_bytes(blob)
        print(name,len(blob),hashlib.sha256(blob).hexdigest())
