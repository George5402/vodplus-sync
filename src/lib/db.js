// D1 小型访问层，所有参数绑定，不拼接用户输入到 SQL。
export const stmt = (env, sql, ...values) => env.DB.prepare(sql).bind(...values);
export const one = (env, sql, ...values) => stmt(env, sql, ...values).first();
export const all = async (env, sql, ...values) => (await stmt(env, sql, ...values).all()).results;
export const run = (env, sql, ...values) => stmt(env, sql, ...values).run();
export const event = (env, owner, device, action, detail) => run(env, 'INSERT INTO events(owner,device,action,detail,created) VALUES(?,?,?,?,?)', owner, device, action, detail, Date.now());
export const decode = row => row && ({ ...row, data: JSON.parse(row.data) });
