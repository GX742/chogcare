export function hiddenPassword(label) {
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error("Use your own interactive terminal. No passwords in chat, arguments or pipes.");
  return new Promise((resolve,reject)=>{
    const raw=process.stdin.isRaw;let value="";
    const done=error=>{process.stdin.off("data",read);process.stdin.setRawMode(raw);process.stdin.pause();process.stdout.write("\n");if(error)reject(error);else resolve(value);value="";};
    const read=chunk=>{for(const c of chunk.toString()){
      if(c==="\u0003"){done(new Error("Cancelled."));return;}
      if(c==="\r"||c==="\n"){done();return;}
      if(c==="\u007f"||c==="\b"){value=value.slice(0,-1);continue;}
      if(c>=" "&&value.length<256)value+=c;
    }};
    process.stdout.write(label);process.stdin.setEncoding("utf8");process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on("data",read);
  });
}
