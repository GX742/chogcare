import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { renderFunnelRelayNginx, renderResilientHlsRelayNginx } from "../ops/relay/nginx-config.mjs";

const options={publicIp:"8.8.8.8",funnelHostname:"relay.synthetic-tailnet.ts.net"};
const paymentBlock=text=>text.slice(text.indexOf("    location ^~ /api/payments/ {"),text.indexOf("    location / { return 404; }",text.indexOf("    location ^~ /api/payments/ {")));

test("resilient HLS changes preserve the payment route byte-for-byte and bind every proxy destination",()=>{
  const canonical=renderFunnelRelayNginx(options),resilient=renderResilientHlsRelayNginx(options);
  assert.equal(paymentBlock(resilient),paymentBlock(canonical));
  const before=canonical.slice(0,canonical.indexOf("    location ^~ /hls/ {"));
  assert.equal(resilient.slice(0,before.length),before,"Host/session/TLS/header guards are unchanged");
  assert.match(resilient,/server relay\.synthetic-tailnet\.ts\.net:443;\s*keepalive 16;/);
  assert.doesNotMatch(resilient,/\bresolver\b|set \$chogcare_hls_funnel/);
  assert.match(resilient,/proxy_ssl_verify on;/);assert.doesNotMatch(resilient,/proxy_ssl_verify off/);
  assert.match(resilient,/error_page 502 503 504 = @chogcare_hls_ssh;/);
  assert.match(resilient,/location @chogcare_hls_ssh \{\s*internal;\s*limit_except GET \{ deny all; \}/);
  assert.deepEqual([...resilient.matchAll(/^\s*proxy_pass ([^;\n]+);/gm)].map(match=>match[1]),["https://chogcare_funnel_upstream","http://127.0.0.1:18090","https://chogcare_funnel_upstream"]);
  assert.doesNotMatch(resilient,/proxy_pass[^;]*(?:\$arg_|\$http_|\$request_uri|\$host)/);
  for(const funnelHostname of ["relay.other.invalid","relay.tailnet.ts.net\n","relay.tailnet.ts.net:443","relay.tailnet.ts.net/path","127.0.0.1"]){
    assert.throws(()=>renderResilientHlsRelayNginx({...options,funnelHostname}));
  }
});

// Real nginx, TLS and two transports; all listeners use random loopback
// ports and disposable test certificates. No production host is contacted.
const integrationPython=String.raw`
import http.client, http.server, json, pathlib, shutil, socket, ssl, subprocess, sys, tempfile, threading, time

fixture=json.load(sys.stdin)
def require(condition,category):
    if not condition: raise AssertionError(category)
require(shutil.which("nginx") and shutil.which("openssl"),"ISOLATED_RUNTIME_DEPENDENCY_MISSING")

def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1",0)); return sock.getsockname()[1]

class QuietServer(http.server.ThreadingHTTPServer):
    daemon_threads=True
    def handle_error(self,*args): pass

with tempfile.TemporaryDirectory(prefix="chogcare-hls-failover-test-") as directory:
    base=pathlib.Path(directory);base.chmod(0o755)
    ca=base/"ca.pem";ca_key=base/"ca.key";key=base/"peer.key";certificate=base/"peer.pem";bad_certificate=base/"bad-peer.pem"
    def openssl(arguments):
        result=subprocess.run(["openssl",*arguments],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=8)
        require(result.returncode==0,"ISOLATED_CERTIFICATE_GENERATION_FAILED")
    openssl(["req","-x509","-newkey","rsa:2048","-nodes","-days","1","-subj","/CN=Isolated HLS Test CA","-addext","basicConstraints=critical,CA:TRUE","-addext","keyUsage=critical,keyCertSign,cRLSign","-addext","subjectKeyIdentifier=hash","-keyout",str(ca_key),"-out",str(ca)])
    for name,hostname,target in [("peer",fixture["hostname"],certificate),("bad-peer","wrong-name.invalid",bad_certificate)]:
        request=base/(name+".csr");extensions=base/(name+".ext")
        extensions.write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\nsubjectAltName=DNS:"+hostname+",IP:"+fixture["publicIp"]+"\n")
        openssl(["req","-new","-newkey","rsa:2048","-nodes","-subj","/CN="+hostname,"-keyout",str(key if name=="peer" else base/"bad-peer.key"),"-out",str(request)])
        openssl(["x509","-req","-in",str(request),"-CA",str(ca),"-CAkey",str(ca_key),"-CAcreateserial","-days","1","-extfile",str(extensions),"-out",str(target)])
    key.chmod(0o600)
    seen=[];servers=[];process=None
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version="HTTP/1.1"
        def log_message(self,*args): pass
        def answer(self):
            size=int(self.headers.get("Content-Length","0"));body=self.rfile.read(size) if size else b""
            seen.append((self.server.role,self.command,self.path,body))
            if self.server.role!="backup" and self.path.startswith("/hls/reset"):
                self.close_connection=True
                try:self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:pass
                self.connection.close();return
            if self.server.role!="backup" and self.path.startswith("/hls/idle"):
                time.sleep(18)
            status=503 if self.server.role!="backup" and (self.path.startswith("/hls/unavailable") or self.path.startswith("/api/payments/")) else 404 if self.path.startswith("/hls/missing") else 200
            data=self.server.role.encode()
            self.send_response(status);self.send_header("Content-Length",str(len(data)));self.send_header("Content-Type","application/vnd.apple.mpegurl");self.end_headers()
            if self.command!="HEAD":
                try:self.wfile.write(data)
                except OSError:pass
        do_GET=answer
        do_HEAD=answer
        do_POST=answer
    primary_port=port()
    for address,role,cert,private in [("127.0.0.1","primary-a",certificate,key),("127.0.0.2","bad-peer",bad_certificate,base/"bad-peer.key")]:
        server=QuietServer((address,primary_port),Handler);server.role=role
        tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);tls.load_cert_chain(cert,private)
        server.socket=tls.wrap_socket(server.socket,server_side=True);servers.append(server)
    backup=QuietServer(("127.0.0.1",0),Handler);backup.role="backup";servers.append(backup)
    for server in servers:threading.Thread(target=server.serve_forever,daemon=True).start()

    http_port=port();https_port=port()
    while https_port==http_port:https_port=port()
    rendered=fixture["configuration"]
    rendered=rendered.replace("listen 80 default_server;","listen 127.0.0.1:%d default_server;"%http_port)
    rendered=rendered.replace("listen 443 ssl default_server;","listen 127.0.0.1:%d ssl default_server;"%https_port)
    rendered=rendered.replace("/etc/letsencrypt/live/chogcare-relay/fullchain.pem",str(certificate)).replace("/etc/letsencrypt/live/chogcare-relay/privkey.pem",str(key))
    rendered=rendered.replace("/etc/ssl/certs/ca-certificates.crt",str(ca))
    rendered=rendered.replace("server "+fixture["hostname"]+":443;","server 127.0.0.1:%d;"%primary_port)
    rendered=rendered.replace("http://127.0.0.1:18090","http://127.0.0.1:%d"%backup.server_port)
    config=base/"nginx.conf"
    prefix="worker_processes 1;\npid "+str(base/"nginx.pid")+";\nerror_log /dev/null emerg;\nevents { worker_connections 64; }\nhttp { access_log off; client_body_temp_path "+str(base/"request-temp")+"; proxy_temp_path "+str(base/"response-temp")+"; "
    config.write_text(prefix+rendered+"}\n")
    trust=ssl.create_default_context(cafile=str(ca))
    def request(path,method="GET",host=None,body=None,timeout=20):
        connection=http.client.HTTPConnection("127.0.0.1",https_port,timeout=timeout)
        connection.sock=trust.wrap_socket(socket.create_connection(("127.0.0.1",https_port),timeout=timeout),server_hostname=fixture["publicIp"])
        connection.request(method,path,body=body,headers={"Host":host or fixture["publicIp"]})
        response=connection.getresponse();result=(response.status,response.read());connection.close();return result
    def backup_count():return sum(item[0]=="backup" for item in seen)
    stage="configuration"
    try:
        checked=subprocess.run(["nginx","-t","-p",str(base)+"/","-c",str(config)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
        require(checked.returncode==0,"ISOLATED_NGINX_CONFIGURATION_REJECTED")
        process=subprocess.Popen(["nginx","-p",str(base)+"/","-c",str(config),"-g","daemon off;"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        deadline=time.monotonic()+4
        while True:
            try:
                with socket.create_connection(("127.0.0.1",https_port),timeout=.2):break
            except OSError:
                require(time.monotonic()<deadline,"ISOLATED_NGINX_START_FAILED");time.sleep(.05)
        stage="primary-tls"
        require(request("/hls/primary.m3u8")== (200,b"primary-a"),"VERIFIED_TLS_PRIMARY_UNAVAILABLE")
        for method in ("GET","HEAD"):
            for reason in ("unavailable","reset"):
                path="/hls/"+reason+".m3u8?token=synthetic%2Fvalue&amount=1"
                before=backup_count();result=request(path,method)
                require(result==(200,b"" if method=="HEAD" else b"backup"),"HLS_"+method+"_"+reason.upper()+"_FAILOVER_FAILED")
                require(backup_count()==before+1 and seen[-1][1:3]==(method,path),"FAILOVER_CHANGED_METHOD_URI_OR_QUERY")
        before=backup_count();require(request("/hls/missing.m3u8")[0]==404,"PRIMARY_404_CHANGED");require(backup_count()==before,"PRIMARY_404_WAS_REPLAYED")
        before=len(seen);require(request("/hls/primary.m3u8","POST",body=b"synthetic")[0]==403,"HLS_POST_NOT_BLOCKED");require(len(seen)==before,"HLS_POST_REACHED_UPSTREAM")
        before=backup_count();require(request("/api/payments/invoices","POST",body=b'{"synthetic":true}')[0]==503,"PAYMENT_RESPONSE_CHANGED")
        require(backup_count()==before,"PAYMENT_POST_WAS_REPLAYED")
        require(sum(item[1]=="POST" and item[2]=="/api/payments/invoices" for item in seen)==1,"PAYMENT_POST_COUNT_CHANGED")
        for path,host in [("/admin/",None),("/api/payments-other/",None),("/hls/%2e%2e/admin/",None),("/hls/../admin/",None),("/hls/primary.m3u8","unrelated.invalid"),("/@chogcare_hls_ssh",None)]:
            before=len(seen);require(request(path,host=host)[0]==404,"RELAY_BOUNDARY_REJECTION_FAILED");require(len(seen)==before,"REJECTED_PATH_OR_HOST_REACHED_UPSTREAM")
        stage="idle-timeout"
        started=time.monotonic();require(request("/hls/idle.m3u8")== (200,b"backup"),"IDLE_TIMEOUT_DID_NOT_FALL_BACK")
        require(13<=time.monotonic()-started<19,"HLS_IDLE_TIMEOUT_IS_NOT_FIFTEEN_SECONDS")
        # A separate disposable nginx process has no cached TLS session or
        # keepalive connection that could mask the deliberately wrong peer.
        process.terminate();process.wait(timeout=3)
        config.write_text(prefix+rendered.replace("server 127.0.0.1:%d;"%primary_port,"server 127.0.0.2:%d;"%primary_port)+"}\n")
        process=subprocess.Popen(["nginx","-p",str(base)+"/","-c",str(config),"-g","daemon off;"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        deadline=time.monotonic()+4
        while True:
            try:
                with socket.create_connection(("127.0.0.1",https_port),timeout=.2):break
            except OSError:
                require(time.monotonic()<deadline,"BAD_PEER_NGINX_START_FAILED");time.sleep(.05)
        stage="bad-peer"
        before=backup_count();require(request("/hls/bad-peer.m3u8")== (200,b"backup"),"BAD_TLS_PEER_DID_NOT_FALL_BACK")
        require(backup_count()==before+1,"BAD_TLS_PEER_DID_NOT_USE_BACKUP")
        require(not any(item[0]=="bad-peer" for item in seen),"WRONG_NAME_TLS_PEER_RECEIVED_HTTP")
        print(json.dumps({"pass":True,"primaryTls":True,"getHeadFailover":True,"uriQueryPreserved":True,"notFoundNotRetried":True,"paymentPostNotReplayed":True,"boundaries":True,"badTlsRejected":True,"idleTimeout":True}))
    except AssertionError as failure:
        print(json.dumps({"pass":False,"category":str(failure)}));sys.exit(1)
    except Exception as failure:
        print(json.dumps({"pass":False,"category":"ISOLATED_"+type(failure).__name__+"_"+stage+"_"+str(getattr(failure,"verify_code",0))}));sys.exit(1)
    finally:
        if process is not None:
            process.terminate()
            try:process.wait(timeout=3)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=2)
        for server in servers:server.shutdown();server.server_close()
`;

test("isolated nginx performs TLS-verified HLS failover while payment POSTs stay single-shot",{timeout:60_000},t=>{
  const wsl=process.platform==="win32"&&process.env.CHOGCARE_RELAY_WSL_TEST==="1";
  if(process.platform==="win32"&&!wsl)return t.skip("Enable CHOGCARE_RELAY_WSL_TEST=1 for isolated WSL nginx integration.");
  const child=spawnSync(wsl?"wsl.exe":"python3",wsl?["-d","Ubuntu","--","python3","-B","-c",integrationPython]:["-B","-c",integrationPython],{
    input:JSON.stringify({publicIp:options.publicIp,hostname:options.funnelHostname,configuration:renderResilientHlsRelayNginx(options)}),encoding:"utf8",windowsHide:true,timeout:55_000,maxBuffer:1_048_576,
  });
  assert.equal(child.error,undefined,"Isolated nginx integration process must complete within its finite deadline");
  let result;try{result=JSON.parse(child.stdout.trim());}catch{assert.fail("Isolated nginx integration returned no safe structured result.");}
  assert.equal(child.status,0,result.category??"Isolated nginx integration failed");
  assert.deepEqual(result,{pass:true,primaryTls:true,getHeadFailover:true,uriQueryPreserved:true,notFoundNotRetried:true,paymentPostNotReplayed:true,boundaries:true,badTlsRejected:true,idleTimeout:true});
});
