import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import {
    AgentRuntime,
    elizaLogger,
    getEnvVariable,
    validateCharacterConfig,
} from "@elizaos/core";

import { REST, Routes } from "discord.js";
import { DirectClient } from ".";

const checkOrigin = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    const origin = req.get("origin");
    const host = req.get("host");

    const isLocalhost =
        origin === "http://localhost:3000" ||
        host === "localhost:3000" ||
        host?.includes("127.0.0.1:3000");

    const isDreamstarter =
        origin?.endsWith("dreamstarter.xyz") ||
        host?.endsWith("dreamstarter.xyz") ||
        origin?.endsWith("dreamstarter.vercel.app") ||
        host?.endsWith("dreamstarter.vercel.app");

    if (isLocalhost || isDreamstarter) {
        next();
    } else {
        res.status(403).json({
            error: "Access forbidden - Invalid origin",
        });
    }
};

export function createApiRouter(
    agents: Map<string, AgentRuntime>,
    directClient: DirectClient
) {
    const router = express.Router();

    const corsOptions = {
        origin: [
            "http://localhost:3000",
            /\.dreamstarter\.xyz$/,
            /\.dreamstarter\.vercel\.app$/,
        ],
        optionsSuccessStatus: 200,
    };

    router.use(cors(corsOptions));
    router.use(bodyParser.json());
    router.use(bodyParser.urlencoded({ extended: true }));
    router.use(
        express.json({
            limit: getEnvVariable("EXPRESS_MAX_PAYLOAD") || "100kb",
        })
    );

    router.use(checkOrigin);

    router.get("/", (req, res) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.send("Welcome to REST API of DreamStarter");
    });

    router.get("/agents", (req, res) => {
        const agentsList = Array.from(agents.values()).map((agent) => ({
            id: agent.agentId,
            name: agent.character.name,
            clients: Object.keys(agent.clients),
        }));
        res.json({ agents: agentsList });
    });

    router.get("/agents/:agentId", (req, res) => {
        const agentId = req.params.agentId;
        const agent = agents.get(agentId);

        if (!agent) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        res.json({
            id: agent.agentId,
            character: agent.character,
        });
    });

    router.post("/agents/:agentId/set", async (req, res) => {
        const agentId = req.params.agentId;
        console.log("agentId", agentId);
        let agent: AgentRuntime = agents.get(agentId);

        // update character
        if (agent) {
            directClient.unregisterAgent(agent);
        }

        // load character from body
        const character = req.body;
        try {
            validateCharacterConfig(character);
        } catch (e) {
            elizaLogger.error(`Error parsing character: ${e}`);
            res.status(400).json({
                success: false,
                message: e.message,
            });
            return;
        }

        // start it up (and register it)
        agent = await directClient.startAgent(character);
        elizaLogger.log(`${character.name} started`);

        res.json({
            id: character.id,
            character: character,
        });
    });

    router.get("/agents/:agentId/channels", async (req, res) => {
        const agentId = req.params.agentId;
        const runtime = agents.get(agentId);

        if (!runtime) {
            res.status(404).json({ error: "Runtime not found" });
            return;
        }

        const API_TOKEN = runtime.getSetting("DISCORD_API_TOKEN") as string;
        const rest = new REST({ version: "10" }).setToken(API_TOKEN);

        try {
            const guilds = (await rest.get(Routes.userGuilds())) as Array<any>;

            res.json({
                id: runtime.agentId,
                guilds: guilds,
                serverCount: guilds.length,
            });
        } catch (error) {
            console.error("Error fetching guilds:", error);
            res.status(500).json({ error: "Failed to fetch guilds" });
        }
    });

    return router;
}
