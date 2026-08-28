import { VideriAuth } from "../videri/auth.js";
import { VideriHttp } from "../videri/http.js";
import { runContractCanary, renderCanary } from "./contract.js";

const http = new VideriHttp(new VideriAuth());
const result = await runContractCanary(http);

console.log(renderCanary(result));
process.exit(result.passed ? 0 : 1);
