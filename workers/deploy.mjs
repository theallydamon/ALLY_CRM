// Run only in an environment signed into Ally's existing Cloudflare account.
// This script cannot sign in, buy a plan, create domains, or change Firebase rules.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('.',import.meta.url)));
const EXPECTED_ACCOUNT='ff1761099dd2cbe87e80ff749a8d75d4';
const cli=fileURLToPath(new URL('./node_modules/wrangler/bin/wrangler.js',import.meta.url));
const env={...process.env,CLOUDFLARE_ACCOUNT_ID:EXPECTED_ACCOUNT,WRANGLER_SEND_METRICS:'false'};
function run(args,{capture=false,input}={}) {
  const result=spawnSync(process.execPath,[cli,...args],{cwd:process.cwd(),env,input,encoding:'utf8',stdio:capture?['pipe','pipe','pipe']:input?['pipe','inherit','inherit']:'inherit'});
  if(result.error || result.status!==0) throw new Error('Cloudflare command failed: '+args.slice(0,3).join(' ')+'. Inspect the terminal error; do not upgrade billing.');
  if(capture)return result.stdout;
}
const account=JSON.parse(run(['whoami','--json'],{capture:true}));
if(!account.loggedIn || !account.accounts?.some(item=>item.id===EXPECTED_ACCOUNT)) throw new Error('Sign in to the verified Ally Cloudflare account first.');
const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
if(config.name!=='ally-crm-connector' || config.vars.FIREBASE_PROJECT!=='ally-crm-cbdd1') throw new Error('Unexpected deployment target.');
const existingSecrets=JSON.parse(run(['secret','list','--format','json','--config','wrangler.jsonc'],{capture:true}));
if(!existingSecrets.some(item=>item.name==='FIREBASE_SERVER_API_KEY')) throw new Error('Set FIREBASE_SERVER_API_KEY on the existing Worker before deploying. Use a dedicated key restricted to Identity Toolkit API and Token Service API; preserve browser-key website restrictions.');
let databases=JSON.parse(run(['d1','list','--json'],{capture:true}));
let db=databases.find(item=>item.name==='ally-crm-connector-auth');
if(!db){run(['d1','create','ally-crm-connector-auth']);databases=JSON.parse(run(['d1','list','--json'],{capture:true}));db=databases.find(item=>item.name==='ally-crm-connector-auth');}
if(!db || !/^[a-f0-9-]{36}$/i.test(db.uuid)) throw new Error('D1 database ID could not be verified.');
config.account_id=EXPECTED_ACCOUNT;config.d1_databases[0].database_id=db.uuid;
writeFileSync('wrangler.deploy.json',JSON.stringify(config,null,2)+'\n');
const flags=['--config','wrangler.deploy.json'];
run(['d1','migrations','apply','AUTH_DB','--remote',...flags]);
run(['deploy',...flags]); // Without the encryption key, authenticated routes remain unavailable.
const secrets=JSON.parse(run(['secret','list','--format','json',...flags],{capture:true}));
if(!secrets.some(item=>item.name==='CONNECTION_KEY')) {
  // Secret travels only through stdin to Wrangler, never through command arguments or chat.
  run(['secret','bulk',...flags],{input:JSON.stringify({CONNECTION_KEY:randomBytes(32).toString('base64')})});
}
const response=await fetch(config.vars.PUBLIC_ORIGIN+'/health');
const health=await response.json();
if(!response.ok || health.version!=='3.0.0' || !health.configured) throw new Error('Deployment returned, but health is not verified. Retry the health URL later; do not claim CRM access yet.');
console.log('Connector health verified: version 3.0.0, configuration present.');
console.log('Google authorization and an authenticated CRM read are still required.');
