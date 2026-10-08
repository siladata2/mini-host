import "dotenv/config";
import express from "express";
import multer from "multer";

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


// ==============================
// HOME
// ==============================

app.get("/", (req, res) => {
    res.sendFile(process.cwd() + "/index.html");
});


// ==============================
// HEALTH CHECK
// ==============================

app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        message: "Mini Heroku is running",
        heroku: Boolean(process.env.HEROKU_API_KEY)
    });
});


// ==============================
// GET APPS
// ==============================

app.get("/api/apps", async (req, res) => {

    try {

        const apps = await getApps();

        res.json({
            success: true,
            apps: apps.map(app => ({
                id: app.id,
                name: app.name,
                url: app.web_url,
                created: app.created_at,
                updated: app.updated_at
            }))
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});


// ==============================
// GET ONE APP
// ==============================

app.get("/api/apps/:name", async (req, res) => {

    try {

        const appData = await getApp(req.params.name);

        res.json({
            success: true,
            app: appData
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});


// ==============================
// CREATE APP
// ==============================

app.post("/api/apps", async (req, res) => {

    try {

        const { name } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                error: "App name is required"
            });
        }

        const appData = await createApp(name);

        res.json({
            success: true,
            app: appData
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});


// ==============================
// RESTART APP
// ==============================

app.post("/api/apps/:name/restart", async (req, res) => {

    try {

        await restartApp(req.params.name);

        res.json({
            success: true,
            message: "App restarted successfully"
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});


// ==============================
// DELETE APP
// ==============================

app.delete("/api/apps/:name", async (req, res) => {

    try {

        await deleteApp(req.params.name);

        res.json({
            success: true,
            message: "App deleted successfully"
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});


// ==============================
// START SERVER
// ==============================

app.listen(PORT, () => {

    console.log("");
    console.log("=================================");
    console.log("       MINI HEROKU RUNNING");
    console.log("=================================");
    console.log(`Local: http://localhost:${PORT}`);
    console.log(
        `Heroku API: ${
            process.env.HEROKU_API_KEY
                ? "CONNECTED"
                : "NOT CONFIGURED"
        }`
    );
    console.log("=================================");
    console.log("");

});