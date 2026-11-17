// 结构化记录提交前读取目标记录及空间游标；文件由目录文档事务单独处理。
import { stmt, decode } from '../lib/db.js';
export async function readCommitContext(env, owner, patch) {
  const statements = [
    stmt(env, 'SELECT COALESCE(MAX(seq),0) value FROM changes WHERE owner=?', owner),
    stmt(env, 'SELECT * FROM entities WHERE owner=? AND id=?', owner, patch.id)
  ];
  let countIndex;
  if (patch.baseVersion === 0) { countIndex = statements.length; statements.push(stmt(env, 'SELECT COUNT(*) total FROM entities WHERE owner=?', owner)); }
  const results = await env.DB.batch(statements);
  return {
    checkpoint: results[0].results[0].value,
    current: decode(results[1].results[0]),
    rows: [],
    total: countIndex === undefined ? 0 : results[countIndex].results[0].total,
    policy: null
  };
}
