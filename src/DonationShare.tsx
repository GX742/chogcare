import { useState } from "react";
import { ArrowUpRight, Copy, Check, XLogo } from "@phosphor-icons/react";
import { donationShare } from "./donation-share";

export default function DonationShare(props:{state:string;mode:"chog"|"nft";amount:string;initiativeId:string}) {
  const [copied,setCopied]=useState(false),[error,setError]=useState("");
  const share=donationShare(props,import.meta.env.VITE_PUBLIC_SITE_URL??(typeof window!=="undefined"?window.location.origin:""));
  if(!share)return null;
  return <div className="donation-share">
    <div className="donation-share-actions">
      <a className="donation-share-x" href={share.href} target="_blank" rel="noopener noreferrer"><XLogo size={19} weight="bold"/>Share on X<ArrowUpRight size={17}/></a>
      <button type="button" className="donation-share-copy" aria-label="Copy donation post" onClick={()=>void navigator.clipboard.writeText(`${share.text}\n${share.site}`).then(()=>{setCopied(true);setError("");}).catch(()=>setError("Couldn't copy. You can select the post text below."))}>{copied?<Check size={18}/>:<Copy size={18}/>}<span>{copied?"Copied":"Copy"}</span></button>
    </div>
    <details className="donation-share-preview"><summary>Preview your post</summary><p>{share.text}</p><span>{share.site}</span><p className="donation-share-note">Opens a draft. You decide when to post.</p></details>
    {share.demo&&<p className="donation-share-note">Demo link — replace before sharing publicly.</p>}
    {error&&<p role="alert">{error}</p>}
  </div>;
}
