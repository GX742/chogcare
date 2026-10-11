// Public-source research, checked 2026-10-09. NOT a signing allowlist.
// Keeping discovery separate prevents a researched address from becoming payable.
const opUsdc = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const solUsdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const sol = "11111111111111111111111111111111";
const route = (chainId, asset, token, recipient) => Object.freeze({chainId,asset,token,recipient});
export const recipientCandidates = Object.freeze([
  Object.freeze({id:"givewell",source:"https://www.givewell.org/about/donate/cryptocurrency",fundDesignation:"Unrestricted Fund",allowsOperatingExpenses:true,blocker:"Owner selected Unrestricted Fund, including operating expenses. Coinbase-managed wallet bridge compatibility and community-fundraiser coordination remain unconfirmed; native SOL, not SPL USDC.",routes:Object.freeze([
    route(792703809,"SOL",sol,"4Z2DBVoQCJZ42cCTDMNvYDUqRjA1C3vV7B155Mc6jGah"),
  ])}),
  Object.freeze({id:"animal-ethics",source:"https://www.animal-ethics.org/cryptocurrencies/",blocker:"Native SOL is explicitly published by Animal Ethics. CHOG can settle to SOL after a signed quote and finalized Solana receipt; the $0.50 NFT route remains gated by the bridge-loss ceiling.",routes:Object.freeze([
    route(792703809,"SOL",sol,"J7XmJiC44bFTbTzoAF69qhWPZq6LUkvf8wPk2UV4zXXL"),
    route(1,"ETH","0x0000000000000000000000000000000000000000","0x6201B6D58fa7EAA7e99552085Bea2CAc25FdeA0c"),
  ])}),
  Object.freeze({id:"school-supplies",source:"https://giveth.io/project/basic-school-supplies-and-crypto-education-initiative",blocker:"Optimism route implemented separately in the signing allowlist. Requires updated healthy worker and acceptable quote; Solana remains research only.",routes:Object.freeze([
    route(792703809,"USDC",solUsdc,"5Fj3udKrQpgTGMjZG1tTsGZhjpdYTPQj97LSQQXkvJAu"),
    route(10,"USDC",opUsdc,"0x8270a0FEBBA70899419E76A98bF2B5DC15Fe2Ff4"),
  ])}),
  Object.freeze({id:"solar-foundation",source:"https://giveth.io/project/the-solar-foundation",blocker:"Optimism route implemented separately in the signing allowlist. Requires updated healthy worker and acceptable quote; Solana remains research only.",routes:Object.freeze([
    route(792703809,"USDC",solUsdc,"9WJ7mNgmnE1u5GMWJ8zXjX6vsyGwimHjbR1fPBcCXiu2"),
    route(10,"USDC",opUsdc,"0x84178186a503ef41d30Da4cDB2bC27AEFA65eD0F"),
  ])}),
  Object.freeze({id:"vida-verde",source:"https://giveth.io/project/vida-verde-venezuela",blocker:"Optimism route implemented separately in the signing allowlist. Requires updated healthy worker and acceptable quote.",routes:Object.freeze([
    route(10,"USDC",opUsdc,"0x05c73EcEF963FD68A414E713F4B28d9E792c73Bd"),
  ])}),
  Object.freeze({id:"heifer",source:"https://www.heifer.org/give/other-ways-to-give/digital-currency",blocker:"No published Solana recipient found. Native ETH address only; do not infer an L2 or use this address for USDC.",routes:Object.freeze([
    route(1,"ETH","0x0000000000000000000000000000000000000000","0xE04063602B8b6B5d3526e6af873d2A4777E12d92"),
  ])}),
]);
