import "dotenv/config";

const HEROKU_API = "https://api.heroku.com";

async function herokuRequest(endpoint, options = {}) {
    const response = await fetch(
        `${HEROKU_API}${endpoint}`,
        {
            ...options,
            headers: {
                "Authorization":
                    `Bearer ${process.env.HEROKU_API_KEY}`,

                "Accept":
                    "application/vnd.heroku+json; version=3",

                "Content-Type":
                    "application/json",

                ...(options.headers || {})
            }
        }
    );

    const text = await response.text();

    let data;

    try {
        data = JSON.parse(text);
    } catch {
        data = {
            message: text
        };
    }

    if (!response.ok) {
        throw new Error(
            data.message ||
            data.error ||
            `Heroku API Error: ${response.status}`
        );
    }

    return data;
}


/* =========================
   ACCOUNT
========================= */

export async function getAccount() {
    return await herokuRequest(
        "/account"
    );
}


/* =========================
   TEAMS
========================= */

export async function getTeams() {
    return await herokuRequest(
        "/teams"
    );
}


/* =========================
   CREATE APP
========================= */

export async function createApp(name) {

    const body = {
        name: name,
        region: "us"
    };

    /*
     * Kama HEROKU_TEAM imewekwa,
     * app itatengenezwa ndani ya Team hiyo.
     */
    if (process.env.HEROKU_TEAM) {
        body.organization = {
            name: process.env.HEROKU_TEAM
        };
    }

    return await herokuRequest(
        "/apps",
        {
            method: "POST",
            body: JSON.stringify(body)
        }
    );
}


/* =========================
   GET APPS
========================= */

export async function getApps() {
    return await herokuRequest(
        "/apps"
    );
}


/* =========================
   GET ONE APP
========================= */

export async function getApp(name) {

    return await herokuRequest(
        `/apps/${encodeURIComponent(name)}`
    );
}


/* =========================
   DELETE APP
========================= */

export async function deleteApp(name) {

    return await herokuRequest(
        `/apps/${encodeURIComponent(name)}`,
        {
            method: "DELETE"
        }
    );
}


/* =========================
   RESTART APP
========================= */

export async function restartApp(name) {

    return await herokuRequest(
        `/apps/${encodeURIComponent(name)}/dynos`,
        {
            method: "DELETE"
        }
    );
}