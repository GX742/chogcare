import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
let db;
try {
  const id=process.argv[2];
  if(id&&!/^[a-f0-9]{64}$/.test(id))throw new Error("Use the exact invoice ID copied from checkout.");
  db=new DatabaseSync(resolve("work/payments/processor.sqlite"),{readOnly:true});
  const rows=id?db.prepare("SELECT document FROM chog_invoices WHERE id=?").all(id):db.prepare("SELECT document FROM chog_invoices ORDER BY rowid DESC LIMIT 25").all();
  console.log(JSON.stringify(rows.map(row=>{const x=JSON.parse(row.document);return {id:x.id,state:x.state,depositAddress:x.depositAddress,amountChog:x.amount,minimumUsdcUnits:x.minOutput,deliveredUsdcUnits:x.deliveredUsdc??null,observedUsdcUnits:x.observedUsdc??null,observedDestinationHash:x.observedDestinationHash??null,depositHash:x.depositHash??null,destinationHash:x.destinationHash??null,expiresAt:new Date(x.expiresAt).toISOString(),message:x.message??null};}),null,2));
  console.log("Read-only. Never delete or reset the database to retry a pending payment.");
}catch {console.error("Could not read payment status. Check that the worker has created its database and the invoice ID is correct.");process.exitCode=1;}
finally{db?.close();}
