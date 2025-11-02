import { cors } from "../utils/cors.js";
export const config = { runtime: "nodejs" };
export default async function handler(req,res){
  try{
    cors(res);
    if(req.method==="OPTIONS") return res.status(200).end();
    res.setHeader("Content-Type","application/json; charset=utf-8");
    return res.status(200).end(JSON.stringify({
      ok:true,
      moduleType:"esm",
      node: process.version,
      hasFetch: typeof fetch==="function",
      env: {
        OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
        OPENAI_MODEL: process.env.OPENAI_MODEL || null
      }
    }));
  }catch(e){
    res.status(500).end(JSON.stringify({ok:false,error:String(e?.message||e)}));
  }
}
