// 在隔离测试中收集真实 D1 行读写量，不记录生产数据。
export function measuredDatabase(db){
  const queries=[];
  const record=(sql,result)=>queries.push({sql,read:result.meta?.rows_read??0,written:result.meta?.rows_written??0});
  const wrap=(raw,sql)=>({
    raw,sql,
    bind(...values){return wrap(raw.bind(...values),sql);},
    async all(){const result=await raw.all();record(sql,result);return result;},
    async run(){const result=await raw.run();record(sql,result);return result;},
    async first(column){const result=await raw.all();record(sql,result);const row=result.results[0];return row?(column?row[column]:row):null;}
  });
  return {queries,DB:{prepare:sql=>wrap(db.prepare(sql),sql),async batch(statements){const results=await db.batch(statements.map(s=>s.raw));results.forEach((result,i)=>record(statements[i].sql,result));return results;}},
    summary(){return {read:queries.reduce((n,q)=>n+q.read,0),written:queries.reduce((n,q)=>n+q.written,0),queries:queries.length};}};
}
