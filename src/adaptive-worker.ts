import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));

/** One serialized RPC stream per persistent native lane. */
export class NativeWorker {
  readonly role:'cpu'|'gpu';
  private child;
  private sequence=0;
  private pending: {id:number;resolve:(v:unknown)=>void;reject:(e:Error)=>void}|undefined;
  private buffer=''; private stderr='';
  private failure:Error|undefined;
  private tail:Promise<void>=Promise.resolve();
  private stopped=false; private closing:Promise<void>|undefined;
  private exited:Promise<void>;
  constructor(role:'cpu'|'gpu') {
    this.role=role;
    this.child=spawn(`${root}build/workload-worker`,[`${root}native`,role],{stdio:['pipe','pipe','pipe']});
    this.child.stdout.setEncoding('utf8'); this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data',(s:string)=> { this.stderr=(this.stderr+s).slice(-8192); });
    this.child.stdin.on('error',(e:Error)=>this.fail(e));
    this.child.on('error',(e:Error)=>this.fail(e));
    this.child.stdout.on('data',(s:string)=> {
      this.buffer+=s;
      if(this.buffer.length>1048576) { this.fail(new Error('Oversized worker response')); this.child.stdin.end(); return; }
      let end:number;
      while((end=this.buffer.indexOf('\n'))>=0) {
        const line=this.buffer.slice(0,end); this.buffer=this.buffer.slice(end+1);
        try {
          const r=JSON.parse(line),pending=this.pending;
          if(!pending || r.id!==pending.id || typeof r.ok!=='boolean') throw new Error('Invalid worker response');
          this.pending=undefined;
          if(r.ok) pending.resolve(r.value);
          else { const e=new Error(`${role} worker: ${r.error}`); pending.reject(e); this.fail(e); }
        } catch(error) { this.fail(error instanceof Error ? error : new Error(String(error))); this.child.stdin.end(); }
      }
    });
    this.exited=new Promise(resolve=>this.child.on('close',code=> {
      this.stopped=true;
      if(!this.closing || code!==0) this.fail(new Error(`${role} worker exited (${code}): ${this.stderr}`));
      resolve();
    }));
  }
  private fail(error:Error) {
    this.failure??=error;
    this.pending?.reject(this.failure); this.pending=undefined;
  }
  private send<T>(op:string,fields:Record<string,unknown>):Promise<T> {
    if(this.failure) return Promise.reject(this.failure);
    if(this.stopped) return Promise.reject(new Error('Worker is closed'));
    const id=++this.sequence;
    return new Promise<T>((resolve,reject)=> {
      this.pending={id,resolve:resolve as (v:unknown)=>void,reject};
      this.child.stdin.write(JSON.stringify({...fields,id,op})+'\n',error=> { if(error) this.fail(error); });
    });
  }
  request<T>(op:string,fields:Record<string,unknown>={}):Promise<T> {
    if(this.closing) return Promise.reject(new Error('Worker is closing'));
    const result=this.tail.then(()=>this.send<T>(op,fields));
    this.tail=result.then(()=>{},()=>{});
    return result;
  }
  diagnostics():string { return this.stderr; }
  close():Promise<void> {
    return this.closing??=this.tail.then(async()=> {
      if(!this.failure && !this.stopped) await this.send('shutdown',{}).catch(()=>{});
      this.child.stdin.end();
      await this.exited;
    });
  }
}
