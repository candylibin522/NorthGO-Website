function initBuiltContact() {
  const form = document.getElementById('enquiry');
  if (document.body.dataset.staticHosting === 'true') {
    form.hidden = true;
    const note = document.createElement('p');
    note.textContent = {
      zh:'請使用本頁的電子郵件或電話聯絡 Northgo。',
      en:'Contact Northgo using the email address or telephone number on this page.',
      ja:'このページに記載のメールアドレスまたは電話番号でお問い合わせください。',
      vi:'Vui lòng liên hệ Northgo qua email hoặc số điện thoại trên trang này.'
    }[lang];
    form.after(note);
    return;
  }
  const preset = new URLSearchParams(location.search).get('service');
  if (preset !== null && /^[0-3]$/.test(preset)) form.elements.service.value = preset;
  const labels = {
    zh:['送出詢問','資料將儲存在此網站的收件系統。','詢問已收件，編號','未能收件，請稍後重試。','請透過網站伺服器開啟此頁以送出詢問。'],
    en:['Submit enquiry','Your details are stored in this site’s enquiry system.','Enquiry received. Reference','Could not receive your enquiry. Please retry.','Open this page through the site server to submit an enquiry.'],
    ja:['お問い合わせを送信','入力情報は本サイトの受付システムに保存されます。','受付番号','受信できませんでした。再試行してください。','送信するにはサイトのサーバーから開いてください。'],
    vi:['Gửi yêu cầu','Thông tin được lưu trong hệ thống tiếp nhận của trang.','Đã tiếp nhận. Mã','Không thể tiếp nhận. Vui lòng thử lại.','Mở trang qua máy chủ để gửi yêu cầu.']
  }[lang];
  const submit = form.querySelector('button[type=submit]');
  submit.textContent = labels[0];
  form.querySelector('.hint').textContent = labels[1];
  form.querySelector('.consent span').textContent = {
    zh:'我同意將上述資料用於處理本次詢問。',
    en:'I agree that these details may be used to handle this enquiry.',
    ja:'入力した情報を本件のお問い合わせ対応に利用することに同意します。',
    vi:'Tôi đồng ý sử dụng thông tin này để xử lý yêu cầu.'
  }[lang];
  const extraLabels = {
    zh:['貨物尺寸或重量','預計日期'], en:['Cargo size or weight','Target date'],
    ja:['貨物の寸法または重量','希望日'], vi:['Kích thước hoặc khối lượng hàng','Ngày dự kiến']
  }[lang];
  ['dimensions','schedule'].forEach((name,index)=>{
    const label=document.createElement('label');
    const input=document.createElement('input');
    label.textContent=extraLabels[index];
    input.name=name;
    input.maxLength=150;
    if(index===1)input.type='date';
    label.append(input);
    form.querySelector('label[for=requirements]').before(label);
  });
  const showFields=()=>{
    const service=form.elements.service.value;
    form.elements.dimensions.parentElement.hidden=service==='3';
    for(const name of ['origin','destination'])form.elements[name].parentElement.hidden=service==='2';
  };
  form.elements.service.addEventListener('change',showFields);
  showFields();
  const status = document.createElement('p');
  status.id = 'enquiryStatus';
  status.setAttribute('role','status');
  form.after(status);
  let reference;
  form.addEventListener('input',()=>{ reference=undefined; });
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(location.protocol==='file:'){ status.textContent=labels[4]; return; }
    reference ||= Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join('');
    submit.disabled=true;
    status.textContent='';
    try {
      const response=await fetch(new URL('api/enquiries',document.baseURI),{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({...Object.fromEntries(new FormData(form)),reference,language:lang,consent:form.querySelector('#consent').checked})
      });
      if(!response.ok) throw new Error('Enquiry rejected');
      const receipt=await response.json();
      status.textContent=labels[2]+' '+receipt.reference;
      form.reset();
      if(preset!==null && /^[0-3]$/.test(preset))form.elements.service.value=preset;
      showFields();
      reference=undefined;
    }catch{ status.textContent=labels[3]; }
    finally{ submit.disabled=false; }
  });
}
