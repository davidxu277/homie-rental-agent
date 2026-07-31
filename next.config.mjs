/** @type {import('next').NextConfig} */
export default {
  // 项目里的相对 import 都带 .ts 后缀（Node 原生跑 TypeScript 的要求），
  // 让打包器也认这个写法，前后端就能共用同一份 src/lib
  typescript: { ignoreBuildErrors: false },

  // 房源数据是运行时 readFile 读进来的，路径由 join() 拼出来 ——
  // 打包器的静态分析看不出这是个依赖，不显式声明的话 Serverless 函数包里
  // 就没有这个文件：本地一切正常，线上第一个请求就 500。
  outputFileTracingIncludes: {
    "/api/chat": ["./data/listings.clean.json"],
  },
};
