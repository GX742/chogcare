export const initiativeNames: Record<string,string> = { burundi: "Perfect Villages in Burundi", "animal-ethics": "Animal Ethics", "school-supplies": "School Supplies & Crypto Education", "solar-foundation": "The Solar Foundation", "vida-verde": "+Vida +Verde Venezuela" };
export function donationShare(input:{state:string;mode:"chog"|"nft";amount:string;initiativeId:string},configuredUrl="") {
  const initiative=Object.hasOwn(initiativeNames,input.initiativeId)?initiativeNames[input.initiativeId]:null;
  if(!["confirming","delivered"].includes(input.state)||!["chog","nft"].includes(input.mode)||!initiative||typeof input.amount!=="string"||input.amount.match(/^\d{1,8}(\.\d{1,18})?$/)?.[0]!==input.amount||!/[1-9]/.test(input.amount))return null;
  let site=new URL("https://chogcare.vercel.app/");
  try {
    const candidate=new URL(configuredUrl);
    if(candidate.protocol==="https:"&&!candidate.username&&!candidate.password&&/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(candidate.hostname)&&!candidate.hostname.endsWith(".local")&&!candidate.hostname.endsWith(".localhost")&&!/^\d+(\.\d+){3}$/.test(candidate.hostname)) {
      // Only the site's public root is shareable, never a checkout/recovery path.
      candidate.pathname="/";candidate.search="";candidate.hash="";site=candidate;
    }
  }catch{/* Never share localhost, invoice IDs or the current checkout URL. */}
  const [whole,fraction]=input.amount.split(".");
  const amount=whole.replace(/\B(?=(\d{3})+(?!\d))/g,",")+(fraction?`.${fraction}`:"");
  const final=input.state==="delivered";
  const text=input.mode==="chog"
    ? `I donated ${amount} $CHOG to support ${initiative} through ChogCare. ${final?"Donation delivered.":"Received by the initiative, final confirmation in progress."}`
    : `My CHOG NFT helped send $${amount} from the ChogCare pool to ${initiative}. ${final?"Donation delivered.":"Donation received."}`;
  const url=new URL("https://twitter.com/intent/tweet");
  url.searchParams.set("text",text);url.searchParams.set("url",site.href);
  return {text,site:site.href,href:url.href,demo:site.hostname.endsWith(".example")};
}
