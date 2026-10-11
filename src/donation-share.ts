export const initiativeNames: Record<string,string> = { burundi: "Perfect Villages in Burundi", "animal-ethics": "Animal Ethics", "school-supplies": "School Supplies & Crypto Education", "solar-foundation": "The Solar Foundation", "vida-verde": "+Vida +Verde Venezuela" };
export function donationShare(input:{state:string;mode:"chog"|"nft";amount:string;initiativeId:string},configuredUrl="") {
  const initiative=initiativeNames[input.initiativeId];
  if(input.state!=="delivered"||!initiative||!/^\d{1,8}(\.\d{1,18})?$/.test(input.amount)||Number(input.amount)<=0)return null;
  let site=new URL("https://chogcare.example/");
  try {
    const candidate=new URL(configuredUrl);
    if(candidate.protocol==="https:"&&!candidate.username&&!candidate.password&&/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(candidate.hostname)&&!candidate.hostname.endsWith(".local")&&!candidate.hostname.endsWith(".localhost")&&!/^\d+(\.\d+){3}$/.test(candidate.hostname)) {
      candidate.search="";candidate.hash="";site=candidate;
    }
  }catch{/* Never share localhost, invoice IDs or the current checkout URL. */}
  const [whole,fraction]=input.amount.split(".");
  const amount=whole.replace(/\B(?=(\d{3})+(?!\d))/g,",")+(fraction?`.${fraction}`:"");
  const text=input.mode==="chog"
    ? `I donated ${amount} $CHOG to support ${initiative} through ChogCare. Delivered to the initiative.`
    : `My CHOG NFT helped send $0.50 from the ChogCare pool to ${initiative}. Donation delivered.`;
  const url=new URL("https://twitter.com/intent/tweet");
  url.searchParams.set("text",text);url.searchParams.set("url",site.href);
  return {text,site:site.href,href:url.href,demo:site.hostname.endsWith(".example")};
}
