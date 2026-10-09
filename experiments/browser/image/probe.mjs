import http from 'node:http';
import fs from 'node:fs';
import {chromium} from 'playwright';
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const page=await browser.newPage();
await page.goto('http://127.0.0.1/fixture');
await page.evaluate(()=>{window.lab.counter=123;window.frontProof={nonce:crypto.randomUUID(),timeOrigin:performance.timeOrigin};document.querySelector('#note').value='Unsaved frontend draft';const marker=document.createElement('div');marker.id='volatile-marker';marker.textContent=window.frontProof.nonce;document.body.appendChild(marker)});
browser.on('disconnected',()=>console.error('BROWSER DISCONNECTED',new Date().toISOString()));
http.createServer(async(req,res)=>{
  try{const value=await page.evaluate(()=>({lab:window.lab,frontProof:window.frontProof,input:document.querySelector('#note').value,marker:document.querySelector('#volatile-marker').textContent}));res.end(JSON.stringify(value))}
  catch(error){res.statusCode=500;res.end(error.stack)}
}).listen(8090,'127.0.0.1');
console.log('PROBE READY');
