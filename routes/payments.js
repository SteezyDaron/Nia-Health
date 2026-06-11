'use strict';
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');

function maskValue(val, type='default') {
  if (!val || val.trim().length < 4) return '••••••••';
  if (type==='phone') return val.slice(0,4)+' *** *** '+val.slice(-3);
  if (type==='key')   return val.slice(0,8)+'•'.repeat(18)+val.slice(-4);
  return val.slice(0,4)+'••••••'+val.slice(-4);
}
async function getSetting(db,key) {
  try { const {rows}=await db.query('SELECT setting_val FROM payment_settings WHERE setting_key=$1',[key]); return rows[0]?.setting_val?.trim()||''; } catch{return '';}
}
async function paystackReq(secret,method,path,body=null) {
  const r=await fetch(`https://api.paystack.co${path}`,{method,headers:{'Authorization':`Bearer ${secret}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const d=await r.json(); if(!d.status) throw new Error(d.message||'Paystack error'); return d;
}

/* GET /api/payments/settings — admin */
router.get('/settings', async(req,res)=>{
  try {
    const {rows}=await req.db.query('SELECT setting_key,setting_val,is_sensitive FROM payment_settings ORDER BY setting_key');
    const s={};
    rows.forEach(r=>{
      const v=r.setting_val||'';
      s[r.setting_key]={value:v,masked:r.is_sensitive?maskValue(v,r.setting_key.includes('key')?'key':'default'):v,sensitive:r.is_sensitive,set:v.length>0};
    });
    res.json({settings:s});
  } catch(e){res.status(500).json({error:e.message});}
});

/* PUT /api/payments/settings — admin */
router.put('/settings', async(req,res)=>{
  try {
    const allowed=['paystack_secret_key','paystack_public_key','currency','wellness_price_kes','premium_price_kes','wellness_price_usd','premium_price_usd','business_name','support_email'];
    for(const [k,v] of Object.entries(req.body)){
      if(!allowed.includes(k)) continue;
      const sensitive=['paystack_secret_key','paystack_public_key'].includes(k);
      await req.db.query(`INSERT INTO payment_settings(setting_key,setting_val,is_sensitive) VALUES($1,$2,$3) ON CONFLICT(setting_key) DO UPDATE SET setting_val=$2,updated_at=NOW()`,[k,String(v).trim(),sensitive]);
    }
    res.json({message:'Payment settings saved.'});
  } catch(e){res.status(500).json({error:e.message});}
});

/* POST /api/payments/initialize — user pays */
router.post('/initialize', async(req,res)=>{
  try {
    const {plan}=req.body;
    if(!['wellness','premium'].includes(plan)) return res.status(400).json({error:'Invalid plan.'});
    const secret=await getSetting(req.db,'paystack_secret_key');
    if(!secret) return res.status(503).json({error:'Payments not configured yet. Contact support.'});
    const currency=await getSetting(req.db,'currency')||'KES';
    const priceKey=plan==='wellness'?'wellness_price_kes':'premium_price_kes';
    const price=parseFloat(await getSetting(req.db,priceKey)||(plan==='wellness'?500:1200));
    const ref=`NIA-${req.user.id.slice(0,8).toUpperCase()}-${Date.now()}`;
    const appUrl=process.env.APP_URL||`${req.protocol}://${req.get('host')}`;
    const data=await paystackReq(secret,'POST','/transaction/initialize',{
      email:req.user.email, amount:Math.round(price*100), currency, reference:ref,
      callback_url:`${appUrl}/api/payments/verify?ref=${ref}`,
      metadata:{user_id:req.user.id,plan,user_name:req.user.name},
      channels:['card','bank','ussd','qr','mobile_money','bank_transfer'],
    });
    await req.db.query(`INSERT INTO payments(user_id,amount,currency,plan,method,status,reference) VALUES($1,$2,$3,$4,'paystack','pending',$5)`,[req.user.id,price,currency,plan,ref]);
    res.json({authorization_url:data.data.authorization_url,reference:ref,amount:price,currency,plan});
  } catch(e){console.error('Pay init:',e.message);res.status(500).json({error:e.message});}
});

/* GET /api/payments/verify — Paystack redirect */
router.get('/verify', async(req,res)=>{
  try {
    const {ref}=req.query;
    const secret=await getSetting(req.db,'paystack_secret_key');
    const data=await paystackReq(secret,'GET',`/transaction/verify/${ref}`);
    if(data.data.status==='success'){
      const {rows:[p]}=await req.db.query(`UPDATE payments SET status='completed',updated_at=NOW() WHERE reference=$1 RETURNING *`,[ref]);
      if(p){
        await req.db.query('UPDATE users SET plan=$1 WHERE id=$2',[p.plan,p.user_id]);
        await req.db.query(`INSERT INTO notifications(user_id,title,body,type) VALUES($1,$2,$3,'payment')`,[p.user_id,`✅ ${p.plan.charAt(0).toUpperCase()+p.plan.slice(1)} Plan Activated!`,`Your payment of ${p.currency} ${p.amount} was received. Welcome to ${p.plan} plan! 🌿`]);
      }
      return res.redirect('/?payment=success');
    } else {
      await req.db.query(`UPDATE payments SET status='failed',updated_at=NOW() WHERE reference=$1`,[ref]);
      return res.redirect('/?payment=failed');
    }
  } catch(e){res.redirect('/?payment=error');}
});

/* POST /api/payments/webhook — Paystack webhook */
router.post('/webhook', express.raw({type:'application/json'}), async(req,res)=>{
  try {
    const secret=await getSetting(req.db,'paystack_secret_key');
    const hash=crypto.createHmac('sha512',secret).update(req.body).digest('hex');
    if(hash!==req.headers['x-paystack-signature']) return res.sendStatus(401);
    const event=JSON.parse(req.body);
    if(event.event==='charge.success'){
      const ref=event.data.reference;
      const {user_id,plan}=event.data.metadata||{};
      if(user_id&&plan){
        const {rows:[p]}=await req.db.query(`UPDATE payments SET status='completed',updated_at=NOW() WHERE reference=$1 RETURNING *`,[ref]);
        if(p){ await req.db.query('UPDATE users SET plan=$1 WHERE id=$2',[plan,user_id]); }
      }
    }
    res.sendStatus(200);
  } catch(e){res.sendStatus(200);}
});

/* GET /api/payments/history — user */
router.get('/history', async(req,res)=>{
  try {
    const {rows}=await req.db.query(`SELECT id,amount,currency,plan,method,status,reference,created_at FROM payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,[req.user.id]);
    res.json({payments:rows});
  } catch(e){res.status(500).json({error:e.message});}
});

/* GET /api/payments/revenue — admin */
router.get('/revenue', async(req,res)=>{
  try {
    const [total,monthly,byPlan,byMethod,recent]=await Promise.all([
      req.db.query("SELECT COALESCE(SUM(amount),0) as total FROM payments WHERE status='completed'"),
      req.db.query("SELECT COALESCE(SUM(amount),0) as total FROM payments WHERE status='completed' AND created_at>NOW()-INTERVAL '30 days'"),
      req.db.query("SELECT plan,COUNT(*) as count,SUM(amount) as revenue FROM payments WHERE status='completed' GROUP BY plan"),
      req.db.query("SELECT method,COUNT(*) as count FROM payments WHERE status='completed' GROUP BY method"),
      req.db.query(`SELECT p.id,p.amount,p.currency,p.plan,p.status,p.reference,p.created_at,u.name as user_name,u.email FROM payments p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 25`),
    ]);
    res.json({total:parseFloat(total.rows[0].total),monthly:parseFloat(monthly.rows[0].total),by_plan:byPlan.rows,by_method:byMethod.rows,recent:recent.rows});
  } catch(e){res.status(500).json({error:e.message});}
});

/* GET /api/payments/all — admin */
router.get('/all', async(req,res)=>{
  try {
    const {status,limit=50,offset=0}=req.query;
    let q=`SELECT p.*,u.name as user_name,u.email FROM payments p JOIN users u ON u.id=p.user_id WHERE 1=1`;
    const params=[];
    if(status){params.push(status);q+=` AND p.status=$${params.length}`;}
    q+=` ORDER BY p.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(parseInt(limit),parseInt(offset));
    const {rows}=await req.db.query(q,params);
    res.json({payments:rows});
  } catch(e){res.status(500).json({error:e.message});}
});

module.exports = router;
