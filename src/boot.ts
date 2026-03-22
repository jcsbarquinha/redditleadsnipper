/**
 * Loaded first so Render logs show startup context even if the rest crashes.
 */
process.on("uncaughtException", (err) => {
  console.error("[leadsnipe] uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[leadsnipe] unhandledRejection", reason);
});
console.log("[leadsnipe] boot", {
  PORT: process.env.PORT,
  NODE_ENV: process.env.NODE_ENV,
  cwd: process.cwd(),
});
