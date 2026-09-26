import hashlib,json,pathlib,sqlite3,sys
source=pathlib.Path(sys.argv[1]); db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
statement='';statements=0
with source.open() as stream:
 for line in stream:
  statement+=line
  if sqlite3.complete_statement(statement):
   db.execute(statement);statement='';statements+=1
if statement.strip():raise RuntimeError('Incomplete export')
print('Restored',statements,'statements in memory',flush=True)
result={}
for table in ['author','poem']:
 columns=[r['name'] for r in db.execute(f"SELECT name FROM pragma_table_info('{table}')") if table!='poem' or r['name'] not in ['hidden','source_url','collected_at','rig_last_error']]
 names=','.join('"'+c+'"' for c in columns);digest=hashlib.sha256();count=0
 for row in db.execute(f'SELECT {names} FROM {table} ORDER BY id'):
  digest.update((json.dumps(dict(row),ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n').encode());count+=1
 result[table]={'columns':columns,'rows':count,'sha256':digest.hexdigest()}
result['visibility']=[dict(r) for r in db.execute('SELECT publishable,count(*) AS count FROM poem GROUP BY publishable')]
result['counts']=[dict(r) for r in db.execute('SELECT (SELECT count(*) FROM author) AS authors,(SELECT count(*) FROM poem) AS poems,(SELECT count(*) FROM poem WHERE publication_json IS NOT NULL) AS publications,(SELECT count(*) FROM pragma_foreign_key_check) AS fk_errors')]
result['integrity']=db.execute('PRAGMA integrity_check').fetchone()[0]
assert result['integrity']=='ok'
pathlib.Path(sys.argv[2]).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
db.close()
