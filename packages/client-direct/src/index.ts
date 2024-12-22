import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import { defaultCharacter, elizaLogger } from "@ai16z/eliza";
import forge from "node-forge";
import { composeContext } from "@ai16z/eliza";
import { generateMessageResponse } from "@ai16z/eliza";
import { messageCompletionFooter } from "@ai16z/eliza";
import { AgentRuntime } from "@ai16z/eliza";
import {
    Content,
    Memory,
    ModelClass,
    Client,
    IAgentRuntime,
} from "@ai16z/eliza";
import { stringToUuid } from "@ai16z/eliza";
import { settings } from "@ai16z/eliza";
import { createApiRouter } from "./api.ts";
import { TwitterClientInterface } from "@ai16z/client-twitter";

export const messageHandlerTemplate =
    // {{goals}}
    `# Action Examples
{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Knowledge
{{knowledge}}

# Task: Generate dialog and actions for the character {{agentName}}.
About {{agentName}}:
{{bio}}
{{lore}}

{{providers}}

{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{messageDirections}}

{{recentMessages}}

{{actions}}

# Instructions: Write the next message for {{agentName}}.
` + messageCompletionFooter;

export class DirectClient {
    public app: express.Application;
    private agents: Map<string, AgentRuntime>; // container management
    private server: any; // Store server instance
    public startAgent: Function; // Store startAgent functor

    constructor() {
        elizaLogger.log("DirectClient constructor");
        this.app = express();
        this.app.use(cors());
        this.agents = new Map();

        this.app.use(bodyParser.json());
        this.app.use(bodyParser.urlencoded({ extended: true }));

        const apiRouter = createApiRouter(this.agents, this);
        this.app.use(apiRouter);

        // Define an interface that extends the Express Request interface

        this.app.post(
            "/:agentId/message",
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                const roomId = stringToUuid(
                    req.body.roomId ?? "default-room-" + agentId
                );
                const userId = stringToUuid(req.body.userId ?? "user");

                let runtime = this.agents.get(agentId);

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                await runtime.ensureConnection(
                    userId,
                    roomId,
                    req.body.userName,
                    req.body.name,
                    "direct"
                );

                const text = req.body.text;
                const messageId = stringToUuid(Date.now().toString());

                const content: Content = {
                    text,
                    attachments: [],
                    source: "direct",
                    inReplyTo: undefined,
                };

                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: runtime.agentId,
                };

                const memory: Memory = {
                    id: messageId,
                    agentId: runtime.agentId,
                    userId,
                    roomId,
                    content,
                    createdAt: Date.now(),
                };

                await runtime.messageManager.createMemory(memory);

                const state = await runtime.composeState(userMessage, {
                    agentName: runtime.character.name,
                });

                const context = composeContext({
                    state,
                    template: messageHandlerTemplate,
                });

                const response = await generateMessageResponse({
                    runtime: runtime,
                    context,
                    modelClass: ModelClass.LARGE,
                });

                // save response to memory
                const responseMessage = {
                    ...userMessage,
                    userId: runtime.agentId,
                    content: response,
                };

                await runtime.messageManager.createMemory(responseMessage);

                if (!response) {
                    res.status(500).send(
                        "No response from generateMessageResponse"
                    );
                    return;
                }

                let message = null as Content | null;

                await runtime.evaluate(memory, state);

                const _result = await runtime.processActions(
                    memory,
                    [responseMessage],
                    state,
                    async (newMessages) => {
                        message = newMessages;
                        return [memory];
                    }
                );

                if (message) {
                    res.json([response, message]);
                } else {
                    res.json([response]);
                }
            }
        );

        this.app.post(
            "/start-twitter-agent",
            async (req: express.Request, res: express.Response) => {
                const username = req.body.username;
                const email = req.body.email;
                const encryptedPassword = req.body.password;
                const tokenAddress = req.body.tokenAddress;
                const ideaName = req.body.ideaName;
                const password = this.decryptPassword(encryptedPassword);
                const agentId = stringToUuid("new-agent-" + tokenAddress);
                const dynamicCharacter = req.body.character;
                let messageExamples = [];
                if (dynamicCharacter?.messageExamples?.length) {
                    messageExamples = dynamicCharacter.messageExamples.map(
                        (example) => {
                            return example.map((e, index) => {
                                return {
                                    user: index === 0 ? "{{user1}}" : ideaName,
                                    content: {
                                        text: e.content.text,
                                    },
                                };
                            });
                        }
                    );
                }

                let runtime: AgentRuntime = await this.startAgent({
                    ...defaultCharacter,
                    name: ideaName,
                    agentName: `${ideaName} Agent`,
                    id: agentId,
                    username,
                    settings: {
                        secrets: {
                            TWITTER_USERNAME: username,
                            TWITTER_PASSWORD: "password",
                            TWITTER_EMAIL: "email",
                        },
                    },
                    system: dynamicCharacter?.system || defaultCharacter.system,
                    bio: dynamicCharacter?.bio || defaultCharacter.bio,
                    lore: dynamicCharacter?.lore || defaultCharacter.lore,
                    messageExamples: dynamicCharacter
                        ? messageExamples
                        : defaultCharacter.messageExamples,
                    postExamples:
                        dynamicCharacter?.postExamples ||
                        defaultCharacter.postExamples,
                    topics: dynamicCharacter?.topics || defaultCharacter.topics,
                    style: dynamicCharacter?.style || defaultCharacter.style,
                    adjectives:
                        dynamicCharacter?.adjectives ||
                        defaultCharacter.adjectives,
                });

                this.agents.set(runtime.agentId, runtime);

                const roomId = stringToUuid(
                    req.body.roomId ?? "default-room-" + tokenAddress
                );

                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                await runtime.ensureConnection(
                    agentId,
                    roomId,
                    req.body.userName,
                    req.body.name,
                    "direct"
                );
                try {
                    await TwitterClientInterface.stop(runtime);
                    const twitterClient: any =
                        await TwitterClientInterface.startExternal(
                            runtime,
                            email,
                            username,
                            password
                        );

                    if (twitterClient) {
                        runtime.clients.twitter = twitterClient;
                        twitterClient.enableSearch = false;
                        res.json({
                            status: 200,
                            agentId: runtime.agentId,
                        });
                    } else {
                        res.json({
                            status: 403,
                            error: "Credentials are wrong",
                        });
                    }
                } catch (error) {
                    console.log(error);
                    res.json({ status: 400 });
                }
            }
        );

        this.app.post(
            "/stop-twitter/:agentId",
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                try {
                    this.unregisterAgent(this.agents.get(agentId));
                    res.json({ status: 200 });
                } catch (error) {
                    console.log(error);
                    res.json({ status: 400 });
                }
            }
        );
    }

    private decryptPassword(encryptedPassword) {
        try {
            const publicKey = process.env.PASSWORD_PUBLIC_KEY || "";
            const encrypted = forge.util.decode64(encryptedPassword);
            const privateKey = forge.pki.privateKeyFromPem(publicKey);
            const decrypted = privateKey.decrypt(encrypted, "RSA-OAEP", {
                md: forge.md.sha256.create(),
                mgf1: {
                    md: forge.md.sha256.create(),
                },
            });

            return decrypted;
        } catch (error) {
            console.error("Decryption failed:", error);
            throw new Error("Failed to decrypt password");
        }
    }

    // agent/src/index.ts:startAgent calls this
    public registerAgent(runtime: AgentRuntime) {
        this.agents.set(runtime.agentId, runtime);
    }

    public unregisterAgent(runtime: AgentRuntime) {
        this.agents.delete(runtime.agentId);
    }

    public start(port: number) {
        console.log("port", port);
        this.server = this.app.listen(port, () => {
            elizaLogger.success(
                `REST API bound to 0.0.0.0:${port}. If running locally, access it at http://localhost:${port}.`
            );
        });

        // Handle graceful shutdown
        const gracefulShutdown = () => {
            elizaLogger.log("Received shutdown signal, closing server...");
            this.server.close(() => {
                elizaLogger.success("Server closed successfully");
                process.exit(0);
            });

            // Force close after 5 seconds if server hasn't closed
            setTimeout(() => {
                elizaLogger.error(
                    "Could not close connections in time, forcefully shutting down"
                );
                process.exit(1);
            }, 5000);
        };

        // Handle different shutdown signals
        process.on("SIGTERM", gracefulShutdown);
        process.on("SIGINT", gracefulShutdown);
    }

    public stop() {
        if (this.server) {
            this.server.close(() => {
                elizaLogger.success("Server stopped");
            });
        }
    }
}

export const DirectClientInterface: Client = {
    start: async (_runtime: IAgentRuntime) => {
        elizaLogger.log("DirectClientInterface start");
        const client = new DirectClient();
        const serverPort = parseInt(settings.SERVER_PORT || "3000");
        client.start(serverPort);
        return client;
    },
    stop: async (_runtime: IAgentRuntime, client?: Client) => {
        if (client instanceof DirectClient) {
            client.stop();
        }
    },
};

export default DirectClientInterface;
