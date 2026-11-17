// 用户主动点击才唤起 App；离开弹窗清除一次性码和深链接。
import { $, esc, time, toast } from '../ui.js';
import { icon } from '../icons.js';
import { bindingLinks } from '../lib/binding-links.js';

export async function showBinding(user, binding) {
  const modal = $('#modal'); const server = location.origin;
  let links; try { links = bindingLinks(server, binding.code); } catch { links = null; }
  modal.innerHTML = `<div class="dialog-heading"><h2>绑定到 ${esc(user.name)}</h2><button type="button" class="icon-button" aria-label="关闭" data-close>×</button></div>
    <div class="dialog-body"><p>在已安装新版 App 的设备上点击“一键绑定”，自动填写服务器并使用设备码绑定。</p>
    <label>同步服务器<input readonly value="${esc(server)}"></label>
    <label>一次性设备码<textarea id="binding-code" readonly rows="3" spellcheck="false">${esc(binding.code)}</textarea></label>
    <small>有效至 ${esc(time(binding.expires))}，只能使用一次。用户由设备码确定，无需填写用户名。</small>
    <p id="binding-status" role="status" class="muted">未安装 App 时，先安装支持同步绑定的新版 App，再打开此弹窗。也可复制设备码，在 App 中手动输入。</p>
    ${links?`<a class="text-xs underline" id="binding-android" href="${esc(links.android)}" rel="noreferrer">Android 浏览器兼容打开</a>`:'<p class="error-text">当前后台使用 HTTP。一键绑定仅支持 HTTPS，请从 HTTPS 域名打开后台。</p>'}</div>
    <div class="dialog-footer"><button type="button" id="copy-binding">${icon('copy')}复制设备码</button>${links?`<a class="button primary" id="open-binding" href="${esc(links.direct)}" rel="noreferrer">${icon('devices')}一键绑定</a>`:'<button class="primary" disabled>一键绑定</button>'}<button type="button" data-close>完成</button></div>`;
  const codeInput = modal.querySelector('#binding-code');
  modal.querySelector('#copy-binding').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(binding.code); toast('设备码已复制'); }
    catch { codeInput.focus(); codeInput.select(); toast('已选中设备码，请手动复制'); }
  });
  for (const link of modal.querySelectorAll('a')) link.addEventListener('click', event => {
    if (Date.now() >= binding.expires) { event.preventDefault(); $('#binding-status').textContent='设备码已过期，请关闭后重新生成。'; return; }
    $('#binding-status').textContent='已请求打开 App；若未响应，请确认已安装新版 App，或使用 Android 兼容打开。';
  });
  modal.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => modal.close()));
  modal.returnValue=''; modal.showModal();
  await new Promise(resolve => modal.addEventListener('close', resolve, {once:true}));
  modal.replaceChildren();
}
