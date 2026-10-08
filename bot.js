console.log("=================================");
console.log("       MINI HEROKU TEST BOT");
console.log("=================================");
console.log("🟢 BOT IS ACTIVE");
console.log("Started:", new Date().toISOString());
console.log("=================================");

setInterval(() => {
    console.log(
        `🟢 Bot is still active: ${new Date().toISOString()}`
    );
}, 30000);