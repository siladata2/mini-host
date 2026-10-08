import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";

import {
    createApp,
    getApps,
    getApp,
    deleteApp,
    restartApp
} from "./heroku.js";

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
    dest: "uploads/",
    limits: {
        fileSize: 50 * 1024 * 1024
    }
});

app.use(express.json());
app.use(express.static("."));


// ========================================
// HOME
// ========================================

app.get("/", (req, res) => {
    res.sendFile(path.join(process.cwd(), "index.html"));
});


// ========================================
// HEALTH
// ========================================

app.get("/api/health", (req, res) => {

    res.json({
        success: true,
        heroku: Boolean(process.env.HEROKU_API_KEY)
    });

});


// ========================================
// GET APPS
// ========================================

app.get("/api/apps", async (req, res) => {

    try {

        const apps = await getApps();

        res.json({
            success: true,

            apps: apps.map(item => ({
                id: item.id,
                name: item.name,
                url: item.web_url,
                created: item.created_at,
                updated: item.updated_at
            }))
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});


// ========================================
// GET ONE APP
// ========================================

app.get("/api/apps/:name", async (req, res) => {

    try {

        const result =
            await getApp(req.params.name);

        res.json({
            success: true,
            app: result
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});


// ========================================
// CREATE APP
// ========================================

app.post("/api/apps", async (req, res) => {

    try {

        const { name } = req.body;

        if (!name) {

            return res.status(400).json({
                success: false,
                error: "App name is required"
            });

        }

        const result =
            await createApp(name);

        res.json({
            success: true,
            app: result
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});


// ========================================
// DEPLOY BOT
// ========================================

app.post(
    "/api/deploy",
    upload.single("bot"),
    async (req, res) => {

        let tempDirectory = null;
        let tarFile = null;

        try {

            // --------------------------------
            // CHECK FILE
            // --------------------------------

            if (!req.file) {

                throw new Error(
                    "Please upload a ZIP file."
                );

            }


            if (
                !req.file.originalname
                    .toLowerCase()
                    .endsWith(".zip")
            ) {

                throw new Error(
                    "Only ZIP files are allowed."
                );

            }


            // --------------------------------
            // APP NAME
            // --------------------------------

            let appName =
                String(
                    req.body.name || "mini-bot"
                )
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, "-")
                .replace(/-+/g, "-")
                .replace(/^-|-$/g, "");


            if (!appName) {

                appName =
                    "mini-bot-" +
                    Date.now();

            }


            // Heroku app names max 30 chars

            appName =
                appName.substring(0, 30);


            console.log(
                "Creating app:",
                appName
            );


            // --------------------------------
            // CREATE HEROKU APP
            // --------------------------------

            const herokuApp =
                await createApp(appName);


            console.log(
                "App created:",
                herokuApp.name
            );


            // --------------------------------
            // TEMP DIRECTORY
            // --------------------------------

            tempDirectory =
                path.join(
                    process.cwd(),
                    "uploads",
                    "deploy-" +
                    crypto.randomUUID()
                );


            fs.mkdirSync(
                tempDirectory,
                {
                    recursive: true
                }
            );


            // --------------------------------
            // EXTRACT ZIP
            // --------------------------------

            execFileSync(
                "unzip",
                [
                    "-q",
                    req.file.path,
                    "-d",
                    tempDirectory
                ]
            );


            // --------------------------------
            // FIND BOT ROOT
            // --------------------------------

            let sourceDirectory =
                tempDirectory;


            const entries =
                fs.readdirSync(
                    tempDirectory
                );


            if (
                entries.length === 1 &&
                fs.statSync(
                    path.join(
                        tempDirectory,
                        entries[0]
                    )
                ).isDirectory()
            ) {

                sourceDirectory =
                    path.join(
                        tempDirectory,
                        entries[0]
                    );

            }


            // --------------------------------
            // MAKE SURE PROCFILE EXISTS
            // --------------------------------

            const procfile =
                path.join(
                    sourceDirectory,
                    "Procfile"
                );


            if (!fs.existsSync(procfile)) {

                fs.writeFileSync(
                    procfile,
                    "worker: node bot.js\n"
                );

            }


            // --------------------------------
            // CREATE TAR.GZ
            // --------------------------------

            tarFile =
                path.join(
                    process.cwd(),
                    "uploads",
                    "source-" +
                    crypto.randomUUID() +
                    ".tar.gz"
                );


            execFileSync(
                "tar",
                [
                    "-czf",
                    tarFile,
                    "-C",
                    sourceDirectory,
                    "."
                ]
            );


            // --------------------------------
            // ASK HEROKU FOR SOURCE URL
            // --------------------------------

            const sourceResponse =
                await fetch(
                    "https://api.heroku.com/sources",
                    {
                        method: "POST",

                        headers: {
                            "Authorization":
                                `Bearer ${process.env.HEROKU_API_KEY}`,

                            "Accept":
                                "application/vnd.heroku+json; version=3",

                            "Content-Type":
                                "application/json"
                        },

                        body: "{}"
                    }
                );


            const source =
                await sourceResponse.json();


            if (!sourceResponse.ok) {

                throw new Error(
                    source.message ||
                    "Could not create Heroku source"
                );

            }


            // --------------------------------
            // UPLOAD SOURCE
            // --------------------------------

            const sourceBuffer =
                fs.readFileSync(
                    tarFile
                );


            const uploadResponse =
                await fetch(
                    source.source_blob.put_url,
                    {
                        method: "PUT",

                        headers: {
                            "Content-Type":
                                "application/octet-stream"
                        },

                        body: sourceBuffer
                    }
                );


            if (!uploadResponse.ok) {

                throw new Error(
                    "Failed to upload source to Heroku."
                );

            }


            console.log(
                "Source uploaded."
            );


            // --------------------------------
            // START BUILD
            // --------------------------------

            const buildResponse =
                await fetch(
                    `https://api.heroku.com/apps/${encodeURIComponent(
                        herokuApp.name
                    )}/builds`,
                    {
                        method: "POST",

                        headers: {
                            "Authorization":
                                `Bearer ${process.env.HEROKU_API_KEY}`,

                            "Accept":
                                "application/vnd.heroku+json; version=3",

                            "Content-Type":
                                "application/json"
                        },

                        body: JSON.stringify({

                            source_blob: {

                                url:
                                    source
                                        .source_blob
                                        .get_url,

                                version:
                                    crypto.randomUUID()

                            }

                        })
                    }
                );


            let build =
                await buildResponse.json();


            if (!buildResponse.ok) {

                throw new Error(
                    build.message ||
                    "Could not start Heroku build."
                );

            }


            console.log(
                "Build started:",
                build.id
            );


            // --------------------------------
            // WAIT FOR BUILD
            // --------------------------------

            let buildStatus =
                build.status;


            for (
                let attempt = 0;
                attempt < 60;
                attempt++
            ) {

                if (
                    buildStatus ===
                    "succeeded"
                ) {

                    break;

                }


                if (
                    buildStatus ===
                    "failed"
                ) {

                    break;

                }


                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            3000
                        )
                );


                const checkResponse =
                    await fetch(
                        `https://api.heroku.com/apps/${encodeURIComponent(
                            herokuApp.name
                        )}/builds/${build.id}`,
                        {
                            headers: {
                                "Authorization":
                                    `Bearer ${process.env.HEROKU_API_KEY}`,

                                "Accept":
                                    "application/vnd.heroku+json; version=3"
                            }
                        }
                    );


                build =
                    await checkResponse.json();


                buildStatus =
                    build.status;


                console.log(
                    "Build status:",
                    buildStatus
                );

            }


            // --------------------------------
            // BUILD FAILED
            // --------------------------------

            if (
                buildStatus !==
                "succeeded"
            ) {

                throw new Error(
                    "Heroku build failed: " +
                    buildStatus
                );

            }


            // --------------------------------
            // START WORKER
            // --------------------------------

            const formationResponse =
                await fetch(
                    `https://api.heroku.com/apps/${encodeURIComponent(
                        herokuApp.name
                    )}/formation`,
                    {
                        method: "PATCH",

                        headers: {
                            "Authorization":
                                `Bearer ${process.env.HEROKU_API_KEY}`,

                            "Accept":
                                "application/vnd.heroku+json; version=3",

                            "Content-Type":
                                "application/json"
                        },

                        body: JSON.stringify([

                            {
                                type: "worker",
                                quantity: 1,
                                size: "eco"
                            }

                        ])
                    }
                );


            const formation =
                await formationResponse.json();


            if (!formationResponse.ok) {

                throw new Error(
                    formation.message ||
                    "Could not start worker."
                );

            }


            // --------------------------------
            // SUCCESS
            // --------------------------------

            res.json({

                ok: true,

                message:
                    "Bot deployed successfully.",

                app:
                    herokuApp.name,

                app_url:
                    herokuApp.web_url,

                build:
                    build.id,

                status:
                    "succeeded",

                worker:
                    "active"

            });


        } catch (error) {

            console.error(
                "DEPLOY ERROR:",
                error
            );


            res.status(500).json({

                ok: false,

                error:
                    error.message

            });


        } finally {

            // --------------------------------
            // CLEAN TEMP FILES
            // --------------------------------

            try {

                if (
                    req.file &&
                    fs.existsSync(
                        req.file.path
                    )
                ) {

                    fs.unlinkSync(
                        req.file.path
                    );

                }

            } catch {}


            try {

                if (
                    tarFile &&
                    fs.existsSync(
                        tarFile
                    )
                ) {

                    fs.unlinkSync(
                        tarFile
                    );

                }

            } catch {}

        }

    }
);


// ========================================
// RESTART
// ========================================

app.post(
    "/api/apps/:name/restart",
    async (req, res) => {

        try {

            await restartApp(
                req.params.name
            );

            res.json({
                success: true,
                message:
                    "Bot restarted successfully."
            });

        } catch (error) {

            res.status(500).json({
                success: false,
                error: error.message
            });

        }

    }
);


// ========================================
// DELETE
// ========================================

app.delete(
    "/api/apps/:name",
    async (req, res) => {

        try {

            await deleteApp(
                req.params.name
            );

            res.json({
                success: true,
                message:
                    "Bot deleted successfully."
            });

        } catch (error) {

            res.status(500).json({
                success: false,
                error: error.message
            });

        }

    }
);


// ========================================
// START SERVER
// ========================================

app.listen(
    PORT,
    () => {

        console.log("");
        console.log(
            "================================"
        );
        console.log(
            "       MINI HEROKU"
        );
        console.log(
            "================================"
        );
        console.log(
            `Server: http://localhost:${PORT}`
        );
        console.log(
            "Heroku API:",
            process.env.HEROKU_API_KEY
                ? "CONNECTED"
                : "NOT CONFIGURED"
        );
        console.log(
            "================================"
        );
        console.log("");

    }
);