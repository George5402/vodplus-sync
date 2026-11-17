// 仓库地址只能进入 Cloudflare 官方部署入口。
const form=document.querySelector('#deploy-form');
form.addEventListener('submit',event=>{event.preventDefault();const value=new FormData(form).get('repository').trim();
  if(!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(value)){document.querySelector('#error').textContent='请输入完整的公开 GitHub 仓库地址。';return;}
  document.querySelector('#error').textContent='';document.querySelector('#deploy-link').href='https://deploy.workers.cloudflare.com/?url='+encodeURIComponent(value.replace(/\/$/,''));document.querySelector('#result').hidden=false;
});
