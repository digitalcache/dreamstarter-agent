import { SearchMode, Tweet } from "agent-twitter-client";
import {
    composeContext,
    generateText,
    getEmbeddingZeroVector,
    IAgentRuntime,
    ModelClass,
    stringToUuid,
    UUID,
} from "@elizaos/core";
import * as fs from "fs";
import { elizaLogger } from "@elizaos/core";
import { ClientBase } from "./base.ts";
import { postActionResponseFooter } from "@elizaos/core";
import { generateTweetActions } from "@elizaos/core";
import { IImageDescriptionService, ServiceType } from "@elizaos/core";
import { buildConversationThread } from "./utils.ts";
import { twitterMessageHandlerTemplate } from "./interactions.ts";
import { DEFAULT_MAX_TWEET_LENGTH } from "./environment.ts";
import { ContentPlan, ContentPlanManager, ScheduledPost } from "./contentPlan";

export const twitterPlanTemplate = `TASK: Generate a %days%-day content plan with approximately %num_per_day% posts per day as an array of posts in JSON format.
Generate the posts in the voice and style and perspective of {{agentName}} @{{twitterUserName}}.
Write all the posts with traits of {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
Your post response should have 1, 2, or 3 sentences, but definitely include the URL only if provided.
Your response should not contain any questions. Brief, concise statements only. The total character count for each post MUST be less than 275 characters (to ensure it fits within Twitter's limits). Use \\n\\n (double spaces) between statements if there are multiple statements in your response.

# Areas of Expertise
{{knowledge}}
{{knowledgeData}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}


# POST EXAMPLES
{{characterPostExamples}}

# INSTRUCTIONS
{{postDirections}}


Response should be a JSON object array inside a JSON markdown block. Correct response format:
\`\`\`json
[
  {
    "day": number,
    "content": {
        "time": string,
        "text": string
    }
  },
  {
    "day": number,
    "content": {
        "time": string,
        "text": string
    }
  },
  ...
]
\`\`\``;

export const twitterPostTemplate = `TASK: Generate a post in the voice and style and perspective of {{agentName}} @{{twitterUserName}}.
Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
Your response should be 1, 2, or 3 sentences, but definitely include the URL if provided.
Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than 275 characters (to ensure it fits within Twitter's limits). Use \\n\\n (double spaces) between statements if there are multiple statements in your response. If there is a URL in the response, prioritize that and reframe sentence but keep under 275 characters.

# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}


# POST EXAMPLES
{{characterPostExamples}}

# INSTRUCTIONS
{{postDirections}}
`;

export const twitterActionTemplate =
    `
# INSTRUCTIONS: Determine actions for {{agentName}} (@{{twitterUserName}}) based on:
{{bio}}
{{postDirections}}

Guidelines:
- Extremely selective engagement
- Direct mentions are priority
- Skip: low-effort content, off-topic, repetitive, promotional content
- For likes: must be deeply relevant to core expertise

Like Criteria (ALL must be met):
1. Content directly relates to agent's primary expertise
2. Contains substantial, meaningful insights
3. Aligns perfectly with agent's knowledge domain
4. Free of controversial/divisive content
5. Original content (not reposts/quotes)

Actions (respond only with tags):
[LIKE] - Perfect expertise match AND exceptional insight (10/10)
[RETWEET] - Must exemplify character values AND add value to followers (9/10)
[QUOTE] - Novel perspective needed + deep expertise (9.8/10)
[REPLY] - Must create meaningful dialogue opportunity (9.9/10)

Tweet:
{{currentTweet}}

# Respond with qualifying action tags only.` + postActionResponseFooter;

/**
 * Truncate text to fit within the Twitter character limit, ensuring it ends at a complete sentence.
 */
// function truncateToCompleteSentence(
//     text: string,
//     maxTweetLength: number = 280
// ): string {
//     if (text.length <= maxTweetLength) {
//         return text;
//     }

//     // Regular expression to match URLs
//     // Matches common URL patterns including various TLDs
//     const urlRegex =
//         /https?:\/\/[^\s]+?\.(?:com|org|net|edu|gov|xyz|io|ai|dev|co|me|info|blog|app|cloud|tech)[^\s]*/gi;

//     // Find all URLs in the text
//     const urls = text.match(urlRegex) || [];

//     // Replace URLs with placeholders to protect them during truncation
//     let processedText = text;
//     const urlMap = new Map<string, string>();

//     urls.forEach((url, index) => {
//         const placeholder = `__URL_${index}__`;
//         urlMap.set(placeholder, url);
//         processedText = processedText.replace(url, placeholder);
//     });

//     // Find the last sentence break before maxTweetLength
//     let truncatedText = processedText;
//     const sentenceBreaks = [...processedText.matchAll(/[.!?]+(?=\s|$)/g)];
//     const lastValidBreak = sentenceBreaks
//         .reverse()
//         .find(
//             (match) => match.index !== undefined && match.index < maxTweetLength
//         );

//     if (lastValidBreak?.index !== undefined) {
//         // Truncate at the last valid sentence break
//         truncatedText = processedText.slice(0, lastValidBreak.index + 1).trim();
//     } else {
//         // If no sentence break found, try to break at last space
//         const lastSpace = processedText.lastIndexOf(" ", maxTweetLength - 3);
//         if (lastSpace !== -1) {
//             truncatedText = processedText.slice(0, lastSpace).trim() + "...";
//         } else {
//             // Hard truncate as last resort
//             truncatedText =
//                 processedText.slice(0, maxTweetLength - 3).trim() + "...";
//         }
//     }

//     // Restore URLs in the truncated text
//     urlMap.forEach((url, placeholder) => {
//         truncatedText = truncatedText.replace(placeholder, url);
//     });

//     // Final length check after URL restoration
//     if (truncatedText.length > maxTweetLength) {
//         // If still too long, do a hard truncate preserving as much as possible
//         const lastUrl = urls.find((url) => truncatedText.includes(url));

//         if (
//             lastUrl &&
//             truncatedText.indexOf(lastUrl) + lastUrl.length > maxTweetLength - 3
//         ) {
//             // If a URL is causing the overflow, truncate before the URL
//             truncatedText =
//                 truncatedText.slice(0, truncatedText.indexOf(lastUrl)).trim() +
//                 "...";
//         } else {
//             // Otherwise, do a hard truncate
//             truncatedText = truncatedText.slice(0, maxTweetLength - 3) + "...";
//         }
//     }

//     return truncatedText;
// }

export class TwitterPostClient {
    client: ClientBase;

    runtime: IAgentRuntime;
    twitterUsername: string;
    numTweets: number;
    numLikes: number;
    numReplies: number;
    numRetweets: number;
    private isProcessing: boolean = false;
    private lastProcessTime: number = 0;
    private isDryRun: boolean;
    enableActionProcessing: boolean;
    enableScheduledPosts: boolean;
    twitterTargetUsers: string;
    postInterval: number;
    actionInterval: number;
    private tweetGenerationTimeoutId: NodeJS.Timeout | null;
    private actionProcessingTimeoutId: NodeJS.Timeout | null;
    contentPlanManager: ContentPlanManager;
    currentPlanId: string | null = null;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
        this.numTweets = 0;
        this.numLikes = 0;
        this.numReplies = 0;
        this.numRetweets = 0;
        this.enableActionProcessing = false;
        this.twitterUsername = this.runtime.getSetting("TWITTER_USERNAME");
        this.isDryRun = this.client.twitterConfig.TWITTER_DRY_RUN;
        this.tweetGenerationTimeoutId = null;
        this.actionProcessingTimeoutId = null;
        this.twitterTargetUsers = "";
        this.enableScheduledPosts = false;
        this.postInterval = 480;
        this.actionInterval = 7200000;
        this.contentPlanManager = new ContentPlanManager(client, runtime);
        // Log configuration on initialization
        elizaLogger.log("Twitter Client Configuration:");
        elizaLogger.log(`- Username: ${this.twitterUsername}`);
        elizaLogger.log(
            `- Dry Run Mode: ${this.isDryRun ? "enabled" : "disabled"}`
        );
        elizaLogger.log(
            `- Post Interval: ${this.postInterval}-${this.postInterval + 20} minutes`
        );
        elizaLogger.log(
            `- Action Processing: ${this.enableActionProcessing ? "enabled" : "disabled"}`
        );
        elizaLogger.log(`- Action Interval: ${this.actionInterval} seconds`);
        elizaLogger.log(
            `- Post Immediately: ${this.client.twitterConfig.POST_IMMEDIATELY ? "enabled" : "disabled"}`
        );
        elizaLogger.log(
            `- Search Enabled: ${this.client.twitterConfig.TWITTER_SEARCH_ENABLE ? "enabled" : "disabled"}`
        );

        if (this.isDryRun) {
            elizaLogger.log(
                "Twitter client initialized in dry run mode - no actual tweets should be posted"
            );
        }
    }

    async start() {
        if (!this.enableScheduledPosts) {
            return;
        }
        if (!this.currentPlanId) {
            const activePlan: any = await this.getActivePlan();
            if (activePlan) {
                this.currentPlanId = activePlan.id;
            } else {
                const plan = await this.generateNewPlan(new Date());
                console.log("PLAN", plan);
                this.currentPlanId = plan.id;
            }
        }

        if (!this.isDryRun) {
            this.startPostExecutionLoop();
        }
    }

    private async getActivePlan() {
        // Get all plans from cache and find the active one
        const activePlanId =
            (await this.runtime.cacheManager.get(
                `twitter/${this.client.profile.username}/active_plan`
            )) || null;

        if (!activePlanId) return null;

        const activePlan =
            (await this.runtime.cacheManager.get(
                `twitter/${this.client.profile.username}/content_plan/${activePlanId}`
            )) || null;

        return activePlan;
    }

    private async startPostExecutionLoop() {
        const checkAndExecute = async () => {
            if (!this.enableScheduledPosts) return;
            console.log("Checking for scheduled posts");
            const nextPost = await this.getNextScheduledPost();
            console.log("Next post:", nextPost);
            if (nextPost && this.shouldExecutePost(nextPost)) {
                await this.executeScheduledPost(nextPost);
            }

            // Schedule next check in 5 minutes
            this.tweetGenerationTimeoutId = setTimeout(
                checkAndExecute,
                5 * 60 * 1000
            );
        };

        checkAndExecute();
    }

    private async getNextScheduledPost() {
        if (!this.currentPlanId) return null;

        const plan = await this.contentPlanManager.getPlan(this.currentPlanId);
        if (!plan || plan.status !== "approved") return null;

        const now = new Date();
        let sortedPosts = plan.posts
            .filter(
                (post) =>
                    post.status === "approved" &&
                    new Date(post.scheduledTime) > now
            )
            .sort(
                (a, b) =>
                    new Date(a.scheduledTime).getTime() -
                    new Date(b.scheduledTime).getTime()
            );

        const requiredPosts = 10 - (sortedPosts?.length || 0);
        const newPosts = [];
        for (let i = 0; i < requiredPosts; i++) {
            const newPost = await this.generateNextPost();
            if (newPost) {
                newPosts.push(newPost);
            }
            setTimeout(() => {}, 10000);
        }

        // Add new posts to the plan
        if (newPosts.length > 0) {
            // Re-sort all posts including new ones
            sortedPosts = [
                ...sortedPosts,
                ...newPosts.filter(
                    (post) =>
                        post.status === "approved" &&
                        new Date(post.scheduledTime) > now
                ),
            ]
                .filter(
                    (post) =>
                        post.status === "approved" &&
                        new Date(post.scheduledTime) > now
                )
                .sort(
                    (a, b) =>
                        new Date(a.scheduledTime).getTime() -
                        new Date(b.scheduledTime).getTime()
                );
        }

        return sortedPosts[0];
    }

    async recalculatePostSchedule(
        plan: ContentPlan,
        newInterval: number
    ): Promise<void> {
        if (!plan) return;
        const now = new Date();
        const updatedPlan = structuredClone(plan);
        const newPosts = [];
        const approvedPosts = plan.posts.filter(
            (post) =>
                post.status === "approved" && new Date(post.scheduledTime) > now
        );
        if (approvedPosts.length < 10) {
            const requiredPosts = 10 - (approvedPosts?.length || 0);
            console.log("required posts count", requiredPosts);
            for (let i = 0; i < requiredPosts; i++) {
                const newPost = await this.generateNextPost();
                if (newPost) {
                    newPosts.push(newPost);
                }
                setTimeout(() => {}, 5000);
            }

            if (newPosts.length > 0) {
                updatedPlan.posts = [
                    ...updatedPlan.posts,
                    ...newPosts.filter(
                        (post) =>
                            post.status === "approved" &&
                            new Date(post.scheduledTime) > now
                    ),
                ]
                    .filter(
                        (post) =>
                            post.status === "approved" &&
                            new Date(post.scheduledTime) > now
                    )
                    .sort(
                        (a, b) =>
                            new Date(a.scheduledTime).getTime() -
                            new Date(b.scheduledTime).getTime()
                    );
            }
        }

        updatedPlan.posts
            .filter(
                (post) =>
                    post.status === "approved" &&
                    new Date(post.scheduledTime) > now
            )
            .sort(
                (a, b) =>
                    new Date(a.scheduledTime).getTime() -
                    new Date(b.scheduledTime).getTime()
            );

        const baseTime = new Date(updatedPlan.posts[0].scheduledTime);
        const isStartingFromNow = baseTime < now;

        for (let i = 0; i < updatedPlan.posts.length; i++) {
            if (i === 0 && !isStartingFromNow) return;
            const newScheduledTime = new Date(baseTime);
            newScheduledTime.setMinutes(
                newScheduledTime.getMinutes() + i * newInterval
            );

            updatedPlan.posts[i].scheduledTime = newScheduledTime;
        }

        await this.contentPlanManager.storePlan(updatedPlan);
    }

    private shouldExecutePost(post: ScheduledPost): boolean {
        const now = new Date();
        const scheduledTime = new Date(post.scheduledTime);
        console.log("twitter USER", this.client.profile.username);
        console.log(
            "SHOULD execute",
            Math.abs(now.getTime() - scheduledTime.getTime()) <= 5 * 60 * 1000
        );
        return (
            Math.abs(now.getTime() - scheduledTime.getTime()) <= 5 * 60 * 1000
        );
    }

    private async executeScheduledPost(post: ScheduledPost) {
        try {
            elizaLogger.log(`Executing scheduled post: ${post.id}`);

            const roomId = stringToUuid(
                "twitter_generate_room-" + this.client.profile.username
            );

            if (this.isDryRun) {
                elizaLogger.info(`Dry run: would have posted: ${post.content}`);
                return;
            }
            await this.postTweet(
                this.runtime,
                this.client,
                post.content,
                roomId,
                post.content,
                this.twitterUsername,
                post.attachments?.length && post.localPath?.length
                    ? post.localPath[0]
                    : null
            );

            // Update post status
            await this.contentPlanManager.updatePost(
                this.currentPlanId,
                post.id,
                {
                    status: "posted",
                }
            );
            await this.generateNextPost();
        } catch (error) {
            elizaLogger.error(
                `Error executing scheduled post ${post.id}:`,
                error
            );
        }
    }

    private async generateNextPost() {
        if (!this.currentPlanId) return;

        const plan = await this.contentPlanManager.getPlan(this.currentPlanId);
        if (!plan) return;

        const nextPost = await this.contentPlanManager.generateNextPost(
            plan,
            this.postInterval
        );
        if (nextPost) {
            // Add the new post to the plan
            plan.posts.push(nextPost);
            plan.metadata.totalPosts = plan.posts.length;
            await this.contentPlanManager.storePlan(plan);
            elizaLogger.log(
                `Generated next post for time: ${nextPost.scheduledTime}`
            );
            return nextPost;
        }
    }

    // New methods for content plan management
    async generateNewPlan(startDate: Date = new Date()): Promise<ContentPlan> {
        return await this.contentPlanManager.generateContentPlan(
            startDate,
            30,
            this.postInterval
        );
    }

    async stopNewTweets() {
        // Stop tweet generation loop
        if (this.tweetGenerationTimeoutId) {
            clearTimeout(this.tweetGenerationTimeoutId);
            this.tweetGenerationTimeoutId = null;
            elizaLogger.log("Tweet generation loop stopped");
        }
    }

    startProcessingActions() {
        this.enableActionProcessing = true;
        const processActionsLoop = async () => {
            if (!this.enableActionProcessing) {
                elizaLogger.log("Action processing stopped");
                return;
            }

            try {
                const results = await this.processTweetActions();
                if (results) {
                    elizaLogger.log(`Processed ${results.length} tweets`);
                    elizaLogger.log(
                        `Next action processing scheduled in ${this.actionInterval / 1000} seconds`
                    );
                }
            } catch (error) {
                elizaLogger.error("Error in action processing loop:", error);
            }

            // Only schedule next iteration if processing is still enabled
            if (this.enableActionProcessing) {
                this.actionProcessingTimeoutId = setTimeout(
                    processActionsLoop,
                    this.actionInterval
                );
            }
        };
        if (!this.isDryRun) {
            processActionsLoop().catch((error) => {
                elizaLogger.error(
                    "Fatal error in process actions loop:",
                    error
                );
            });
        } else {
            if (this.isDryRun) {
                elizaLogger.log(
                    "Action processing loop disabled (dry run mode)"
                );
            } else {
                elizaLogger.log(
                    "Action processing loop disabled by configuration"
                );
            }
        }
    }

    async stop() {
        // Stop action processing
        this.enableActionProcessing = false;
        if (this.actionProcessingTimeoutId) {
            clearTimeout(this.actionProcessingTimeoutId);
            this.actionProcessingTimeoutId = null;
        }
        elizaLogger.log("Action processing stopped");
    }

    createTweetObject(
        tweetResult: any,
        client: any,
        twitterUsername: string
    ): Tweet {
        return {
            id: tweetResult.rest_id,
            name: client.profile.screenName,
            username: client.profile.username,
            text: tweetResult.legacy.full_text,
            conversationId: tweetResult.legacy.conversation_id_str,
            createdAt: tweetResult.legacy.created_at,
            timestamp: new Date(tweetResult.legacy.created_at).getTime(),
            userId: client.profile.id,
            inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
            permanentUrl: `https://twitter.com/${twitterUsername}/status/${tweetResult.rest_id}`,
            hashtags: [],
            mentions: [],
            photos: [],
            thread: [],
            urls: [],
            videos: [],
        } as Tweet;
    }

    async processAndCacheTweet(
        runtime: IAgentRuntime,
        client: ClientBase,
        tweet: Tweet,
        roomId: UUID,
        newTweetContent: string
    ) {
        // Cache the last post details
        await runtime.cacheManager.set(
            `twitter/${client.profile.username}/lastPost`,
            {
                id: tweet.id,
                timestamp: Date.now(),
            }
        );

        // Cache the tweet
        await client.cacheTweet(tweet);

        // Log the posted tweet
        elizaLogger.log(`Tweet posted:\n ${tweet.permanentUrl}`);

        // Ensure the room and participant exist
        await runtime.ensureRoomExists(roomId);
        await runtime.ensureParticipantInRoom(runtime.agentId, roomId);

        // Create a memory for the tweet
        await runtime.messageManager.createMemory({
            id: stringToUuid(tweet.id + "-" + runtime.agentId),
            userId: runtime.agentId,
            agentId: runtime.agentId,
            content: {
                text: newTweetContent.trim(),
                url: tweet.permanentUrl,
                source: "twitter",
            },
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: tweet.timestamp,
        });
    }

    async handleNoteTweet(
        client: ClientBase,
        runtime: IAgentRuntime,
        content: string,
        tweetId?: string,
        attachments?: {
            type: string;
            url: string;
        } | null
    ) {
        try {
            const noteTweetResult = await client.requestQueue.add(
                async () =>
                    await client.twitterClient.sendNoteTweet(
                        content,
                        tweetId,
                        attachments?.url
                            ? [
                                  {
                                      data: fs.readFileSync(attachments.url),
                                      mediaType: attachments.type,
                                  },
                              ]
                            : undefined
                    )
            );
            if (noteTweetResult.errors && noteTweetResult.errors.length > 0) {
                return await this.sendStandardTweet(
                    client,
                    content,
                    tweetId,
                    attachments
                );
            } else {
                return noteTweetResult.data.notetweet_create.tweet_results
                    .result;
            }
        } catch (error) {
            throw new Error(`Note Tweet failed: ${error}`);
        }
    }

    async sendStandardTweet(
        client: ClientBase,
        content: string,
        tweetId?: string,
        attachments?: {
            type: string;
            url: string;
        } | null
    ) {
        try {
            const standardTweetResult = await client.requestQueue.add(
                async () =>
                    await client.twitterClient.sendTweet(
                        content,
                        tweetId,
                        attachments?.url
                            ? [
                                  {
                                      data: fs.readFileSync(attachments.url),
                                      mediaType: attachments.type,
                                  },
                              ]
                            : undefined
                    )
            );
            const body = await standardTweetResult.json();
            if (!body?.data?.create_tweet?.tweet_results?.result) {
                console.error("Error sending tweet; Bad response:", body);
                return;
            }
            return body.data.create_tweet.tweet_results.result;
        } catch (error) {
            elizaLogger.error("Error sending standard Tweet:", error);
            throw error;
        }
    }

    async postTweet(
        runtime: IAgentRuntime,
        client: ClientBase,
        cleanedContent: string,
        roomId: UUID,
        newTweetContent: string,
        twitterUsername: string,
        attachments?: {
            type: string;
            url: string;
        } | null
    ) {
        try {
            elizaLogger.log(`Posting new tweet:\n`);
            let result;

            if (cleanedContent.length > DEFAULT_MAX_TWEET_LENGTH) {
                result = await this.handleNoteTweet(
                    client,
                    runtime,
                    cleanedContent,
                    "",
                    attachments
                );
            } else {
                result = await this.sendStandardTweet(
                    client,
                    cleanedContent,
                    "",
                    attachments
                );
            }

            const tweet = this.createTweetObject(
                result,
                client,
                twitterUsername
            );

            await this.processAndCacheTweet(
                runtime,
                client,
                tweet,
                roomId,
                newTweetContent
            );
            this.numTweets++;
        } catch (error) {
            elizaLogger.error("Error sending tweet:", error);
        }
    }

    /**
     * Generates and posts a new tweet. If isDryRun is true, only logs what would have been posted.
     */
    private async generateNewTweet() {
        elizaLogger.log("Generating new tweet");

        try {
            const roomId = stringToUuid(
                "twitter_generate_room-" + this.client.profile.username
            );
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.client.profile.username,
                this.runtime.character.name,
                "twitter"
            );

            const topics = this.runtime.character.topics.join(", ");

            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: roomId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: topics || "",
                        action: "TWEET",
                    },
                },
                {
                    twitterUserName: this.client.profile.username,
                }
            );

            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.twitterPostTemplate ||
                    twitterPostTemplate,
            });

            elizaLogger.debug("generate post prompt:\n" + context);

            const newTweetContent = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.MEDIUM,
            });

            // First attempt to clean content
            let cleanedContent = "";

            // Try parsing as JSON first
            try {
                const parsedResponse = JSON.parse(newTweetContent);
                if (parsedResponse.text) {
                    cleanedContent = parsedResponse.text;
                } else if (typeof parsedResponse === "string") {
                    cleanedContent = parsedResponse;
                }
            } catch (error) {
                error.linted = true; // make linter happy since catch needs a variable
                // If not JSON, clean the raw content
                cleanedContent = newTweetContent
                    .replace(/^\s*{?\s*"text":\s*"|"\s*}?\s*$/g, "") // Remove JSON-like wrapper
                    .replace(/^['"](.*)['"]$/g, "$1") // Remove quotes
                    .replace(/\\"/g, '"') // Unescape quotes
                    .replace(/\\n/g, "\n") // Unescape newlines
                    .trim();
            }

            if (!cleanedContent) {
                elizaLogger.error(
                    "Failed to extract valid content from response:",
                    {
                        rawResponse: newTweetContent,
                        attempted: "JSON parsing",
                    }
                );
                return;
            }

            // Truncate the content to the maximum tweet length specified in the environment settings, ensuring the truncation respects sentence boundaries.
            // const maxTweetLength = this.client.twitterConfig.MAX_TWEET_LENGTH;
            // if (maxTweetLength) {
            //     cleanedContent = truncateToCompleteSentence(
            //         cleanedContent,
            //         maxTweetLength
            //     );
            // }

            const removeQuotes = (str: string) =>
                str.replace(/^['"](.*)['"]$/, "$1");

            const fixNewLines = (str: string) => str.replaceAll(/\\n/g, "\n");

            // Final cleaning
            cleanedContent = removeQuotes(fixNewLines(cleanedContent));

            if (this.isDryRun) {
                elizaLogger.info(
                    `Dry run: would have posted tweet: ${cleanedContent}`
                );
                return;
            }

            try {
                elizaLogger.log(`Posting new tweet:\n ${cleanedContent}`);
                this.postTweet(
                    this.runtime,
                    this.client,
                    cleanedContent,
                    roomId,
                    newTweetContent,
                    this.twitterUsername
                );
            } catch (error) {
                elizaLogger.error("Error sending tweet:", error);
            }
        } catch (error) {
            elizaLogger.error("Error generating new tweet:", error);
        }
    }

    private async generateTweetContent(
        tweetState: any,
        options?: {
            template?: string;
            context?: string;
        }
    ): Promise<string> {
        const context = composeContext({
            state: tweetState,
            template:
                options?.template ||
                this.runtime.character.templates?.twitterPostTemplate ||
                twitterPostTemplate,
        });

        const response = await generateText({
            runtime: this.runtime,
            context: options?.context || context,
            modelClass: ModelClass.LARGE,
        });
        elizaLogger.debug("generate tweet content response:\n" + response);

        // First clean up any markdown and newlines
        const cleanedResponse = response
            .replace(/```json\s*/g, "") // Remove ```json
            .replace(/```\s*/g, "") // Remove any remaining ```
            .replaceAll(/\\n/g, "\n")
            .trim();

        // Try to parse as JSON first
        try {
            const jsonResponse = JSON.parse(cleanedResponse);
            if (jsonResponse.text) {
                return this.trimTweetLength(jsonResponse.text);
            }
            if (typeof jsonResponse === "object") {
                const possibleContent =
                    jsonResponse.content ||
                    jsonResponse.message ||
                    jsonResponse.response;
                if (possibleContent) {
                    return this.trimTweetLength(possibleContent);
                }
            }
        } catch (error) {
            error.linted = true; // make linter happy since catch needs a variable

            // If JSON parsing fails, treat as plain text
            elizaLogger.debug("Response is not JSON, treating as plain text");
        }

        // If not JSON or no valid content found, clean the raw text
        return this.trimTweetLength(cleanedResponse);
    }

    // Helper method to ensure tweet length compliance
    private trimTweetLength(text: string, maxLength: number = 280): string {
        if (text.length <= maxLength) return text;

        // Try to cut at last sentence
        const lastSentence = text.slice(0, maxLength).lastIndexOf(".");
        if (lastSentence > 0) {
            return text.slice(0, lastSentence + 1).trim();
        }

        // Fallback to word boundary
        return (
            text.slice(0, text.lastIndexOf(" ", maxLength - 3)).trim() + "..."
        );
    }

    /**
     * Processes tweet actions (likes, retweets, quotes, replies). If isDryRun is true,
     * only simulates and logs actions without making API calls.
     */

    private async processTweetActions() {
        if (this.isProcessing) {
            elizaLogger.log("Already processing tweet actions, skipping");
            return null;
        }
        try {
            this.isProcessing = true;
            this.lastProcessTime = Date.now();

            elizaLogger.log("Processing tweet actions");

            if (this.isDryRun) {
                elizaLogger.log("Dry run mode: simulating tweet actions");
                return [];
            }

            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.twitterUsername,
                this.runtime.character.name,
                "twitter"
            );

            if (this.twitterTargetUsers) {
                if (!this.enableActionProcessing) {
                    return;
                }
                const TARGET_USERS = this.twitterTargetUsers.split(",");

                elizaLogger.log("Processing target users:", TARGET_USERS);

                if (TARGET_USERS.length > 0) {
                    // Create a map to store tweets by user
                    const tweetsByUser = new Map<string, Tweet[]>();

                    // Fetch tweets from all target users
                    for (const username of TARGET_USERS) {
                        try {
                            const userTweets = (
                                await this.client.twitterClient.fetchSearchTweets(
                                    `from:${username}`,
                                    5,
                                    SearchMode.Latest
                                )
                            ).tweets;

                            if (userTweets.length > 0) {
                                tweetsByUser.set(username, userTweets);
                                elizaLogger.log(
                                    `Found ${userTweets.length} valid tweets from ${username}`
                                );
                            }
                        } catch (error) {
                            elizaLogger.error(
                                `Error fetching tweets for ${username}:`,
                                error
                            );
                            continue;
                        }
                    }

                    for (const [username, tweets] of tweetsByUser) {
                        if (!this.enableActionProcessing) {
                            break;
                        }
                        if (tweets.length > 0) {
                            for (const tweet of tweets) {
                                await this.client.twitterClient.likeTweet(
                                    tweet.id
                                );
                                elizaLogger.log(`Liked tweet ${tweet.id}`);
                                this.numLikes++;
                                await this.updateActionCounter("like");
                                await new Promise(
                                    (resolve) =>
                                        setTimeout(
                                            resolve,
                                            this.actionInterval /
                                                this.ACTION_LIMITS.like.max
                                        ) // now in ms
                                );
                            }

                            elizaLogger.log(`Liking tweet from ${username}}`);
                        }
                    }
                }
            } else {
                elizaLogger.log(
                    "No target users configured, processing only mentions"
                );
            }

            const homeTimeline = await this.client.fetchTimelineForActions(10);
            const results = [];

            for (const tweet of homeTimeline) {
                if (!this.enableActionProcessing) {
                    elizaLogger.log("Action processing disabled, skipping");
                    break;
                }
                try {
                    // Skip if we've already processed this tweet
                    const memory =
                        await this.runtime.messageManager.getMemoryById(
                            stringToUuid(tweet.id + "-" + this.runtime.agentId)
                        );
                    if (memory) {
                        elizaLogger.log(
                            `Already processed tweet ID: ${tweet.id}`
                        );
                        continue;
                    }

                    if (tweet.username === this.twitterUsername) {
                        elizaLogger.log(`Skipping own tweet: ${tweet.id}`);
                        continue;
                    }

                    const roomId = stringToUuid(
                        tweet.conversationId + "-" + this.runtime.agentId
                    );

                    const tweetState = await this.runtime.composeState(
                        {
                            userId: this.runtime.agentId,
                            roomId,
                            agentId: this.runtime.agentId,
                            content: { text: "", action: "" },
                        },
                        {
                            twitterUserName: this.twitterUsername,
                            currentTweet: `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})\nText: ${tweet.text}`,
                        }
                    );

                    const actionContext = composeContext({
                        state: tweetState,
                        template:
                            this.runtime.character.templates
                                ?.twitterActionTemplate ||
                            twitterActionTemplate,
                    });

                    const actionResponse = await generateTweetActions({
                        runtime: this.runtime,
                        context: actionContext,
                        modelClass: ModelClass.MEDIUM,
                    });

                    if (
                        !actionResponse ||
                        Object.keys(actionResponse).length === 0
                    ) {
                        elizaLogger.log(
                            `No valid actions generated for tweet ${tweet.id}`
                        );
                        await this.createSkippedTweetMemory(tweet, roomId);
                        continue;
                    }

                    if (
                        actionResponse.reply &&
                        !tweet.text.includes(`@${this.twitterUsername}`)
                    ) {
                        elizaLogger.log(
                            `Tweet ${tweet.id} didn't pass additional relevance checks`
                        );
                        await this.createSkippedTweetMemory(tweet, roomId);
                        continue;
                    }

                    const executedActions: string[] = [];

                    // Execute actions
                    if (actionResponse.like && this.canPerformAction("like")) {
                        try {
                            if (this.isDryRun) {
                                elizaLogger.info(
                                    `Dry run: would have liked tweet ${tweet.id}`
                                );
                                executedActions.push("like (dry run)");
                            } else {
                                await this.client.twitterClient.likeTweet(
                                    tweet.id
                                );
                                executedActions.push("like");
                                elizaLogger.log(`Liked tweet ${tweet.id}`);
                                this.numLikes++;
                                await this.updateActionCounter("like");
                                await new Promise(
                                    (resolve) =>
                                        setTimeout(
                                            resolve,
                                            this.actionInterval /
                                                this.ACTION_LIMITS.like.max
                                        ) // now in ms
                                );
                            }
                        } catch (error) {
                            elizaLogger.error(
                                `Error liking tweet ${tweet.id}:`,
                                error
                            );
                        }
                    }
                    // if (
                    //     actionResponse.retweet &&
                    //     this.canPerformAction("retweet")
                    // ) {
                    //     try {
                    //         if (this.isDryRun) {
                    //             elizaLogger.info(
                    //                 `Dry run: would have retweeted tweet ${tweet.id}`
                    //             );
                    //             executedActions.push("retweet (dry run)");
                    //         } else {
                    //             await this.client.twitterClient.retweet(
                    //                 tweet.id
                    //             );
                    //             executedActions.push("retweet");
                    //             elizaLogger.log(`Retweeted tweet ${tweet.id}`);
                    //             this.numRetweets++;
                    //             await this.updateActionCounter("retweet");
                    //         }
                    //     } catch (error) {
                    //         elizaLogger.error(
                    //             `Error retweeting tweet ${tweet.id}:`,
                    //             error
                    //         );
                    //     }
                    // }

                    // if (actionResponse.quote) {
                    //     try {
                    //         // Check for dry run mode
                    //         if (this.isDryRun) {
                    //             elizaLogger.info(
                    //                 `Dry run: would have posted quote tweet for ${tweet.id}`
                    //             );
                    //             executedActions.push("quote (dry run)");
                    //             continue;
                    //         }

                    //         // Build conversation thread for context
                    //         const thread = await buildConversationThread(
                    //             tweet,
                    //             this.client
                    //         );
                    //         const formattedConversation = thread
                    //             .map(
                    //                 (t) =>
                    //                     `@${t.username} (${new Date(t.timestamp * 1000).toLocaleString()}): ${t.text}`
                    //             )
                    //             .join("\n\n");

                    //         // Generate image descriptions if present
                    //         const imageDescriptions = [];
                    //         if (tweet.photos?.length > 0) {
                    //             elizaLogger.log(
                    //                 "Processing images in tweet for context"
                    //             );
                    //             for (const photo of tweet.photos) {
                    //                 const description = await this.runtime
                    //                     .getService<IImageDescriptionService>(
                    //                         ServiceType.IMAGE_DESCRIPTION
                    //                     )
                    //                     .describeImage(photo.url);
                    //                 imageDescriptions.push(description);
                    //             }
                    //         }

                    //         // Handle quoted tweet if present
                    //         let quotedContent = "";
                    //         if (tweet.quotedStatusId) {
                    //             try {
                    //                 const quotedTweet =
                    //                     await this.client.twitterClient.getTweet(
                    //                         tweet.quotedStatusId
                    //                     );
                    //                 if (quotedTweet) {
                    //                     quotedContent = `\nQuoted Tweet from @${quotedTweet.username}:\n${quotedTweet.text}`;
                    //                 }
                    //             } catch (error) {
                    //                 elizaLogger.error(
                    //                     "Error fetching quoted tweet:",
                    //                     error
                    //                 );
                    //             }
                    //         }

                    //         // Compose rich state with all context
                    //         const enrichedState =
                    //             await this.runtime.composeState(
                    //                 {
                    //                     userId: this.runtime.agentId,
                    //                     roomId: stringToUuid(
                    //                         tweet.conversationId +
                    //                             "-" +
                    //                             this.runtime.agentId
                    //                     ),
                    //                     agentId: this.runtime.agentId,
                    //                     content: {
                    //                         text: tweet.text,
                    //                         action: "QUOTE",
                    //                     },
                    //                 },
                    //                 {
                    //                     twitterUserName: this.twitterUsername,
                    //                     currentPost: `From @${tweet.username}: ${tweet.text}`,
                    //                     formattedConversation,
                    //                     imageContext:
                    //                         imageDescriptions.length > 0
                    //                             ? `\nImages in Tweet:\n${imageDescriptions.map((desc, i) => `Image ${i + 1}: ${desc}`).join("\n")}`
                    //                             : "",
                    //                     quotedContent,
                    //                 }
                    //             );

                    //         const quoteContent =
                    //             await this.generateTweetContent(enrichedState, {
                    //                 template:
                    //                     this.runtime.character.templates
                    //                         ?.twitterMessageHandlerTemplate ||
                    //                     twitterMessageHandlerTemplate,
                    //             });

                    //         if (!quoteContent) {
                    //             elizaLogger.error(
                    //                 "Failed to generate valid quote tweet content"
                    //             );
                    //             return;
                    //         }

                    //         elizaLogger.log(
                    //             "Generated quote tweet content:",
                    //             quoteContent
                    //         );

                    //         // Send the tweet through request queue
                    //         const result = await this.client.requestQueue.add(
                    //             async () =>
                    //                 await this.client.twitterClient.sendQuoteTweet(
                    //                     quoteContent,
                    //                     tweet.id
                    //                 )
                    //         );

                    //         const body = await result.json();

                    //         if (
                    //             body?.data?.create_tweet?.tweet_results?.result
                    //         ) {
                    //             elizaLogger.log(
                    //                 "Successfully posted quote tweet"
                    //             );
                    //             executedActions.push("quote");

                    //             // Cache generation context for debugging
                    //             await this.runtime.cacheManager.set(
                    //                 `twitter/quote_generation_${tweet.id}.txt`,
                    //                 `Context:\n${enrichedState}\n\nGenerated Quote:\n${quoteContent}`
                    //             );
                    //         } else {
                    //             elizaLogger.error(
                    //                 "Quote tweet creation failed:",
                    //                 body
                    //             );
                    //         }
                    //     } catch (error) {
                    //         elizaLogger.error(
                    //             "Error in quote tweet generation:",
                    //             error
                    //         );
                    //     }
                    // }

                    // if (actionResponse.reply) {
                    //     try {
                    //         await this.handleTextOnlyReply(
                    //             tweet,
                    //             tweetState,
                    //             executedActions
                    //         );
                    //     } catch (error) {
                    //         elizaLogger.error(
                    //             `Error replying to tweet ${tweet.id}:`,
                    //             error
                    //         );
                    //     }
                    // }

                    // Add these checks before creating memory
                    await this.runtime.ensureRoomExists(roomId);
                    await this.runtime.ensureUserExists(
                        stringToUuid(tweet.userId),
                        tweet.username,
                        tweet.name,
                        "twitter"
                    );
                    await this.runtime.ensureParticipantInRoom(
                        this.runtime.agentId,
                        roomId
                    );

                    // Then create the memory
                    await this.runtime.messageManager.createMemory({
                        id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                        userId: stringToUuid(tweet.userId),
                        content: {
                            text: tweet.text,
                            url: tweet.permanentUrl,
                            source: "twitter",
                            action: executedActions.join(","),
                        },
                        agentId: this.runtime.agentId,
                        roomId,
                        embedding: getEmbeddingZeroVector(),
                        createdAt: tweet.timestamp * 1000,
                    });

                    results.push({
                        tweetId: tweet.id,
                        parsedActions: actionResponse,
                        executedActions,
                    });
                } catch (error) {
                    elizaLogger.error(
                        `Error processing tweet ${tweet.id}:`,
                        error
                    );
                    continue;
                }
            }

            return results; // Return results array to indicate completion
        } catch (error) {
            elizaLogger.error("Error in processTweetActions:", error);
            throw error;
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Handles text-only replies to tweets. If isDryRun is true, only logs what would
     * have been replied without making API calls.
     */
    private async handleTextOnlyReply(
        tweet: Tweet,
        tweetState: any,
        executedActions: string[]
    ) {
        try {
            // Build conversation thread for context
            const thread = await buildConversationThread(tweet, this.client);
            const formattedConversation = thread
                .map(
                    (t) =>
                        `@${t.username} (${new Date(t.timestamp * 1000).toLocaleString()}): ${t.text}`
                )
                .join("\n\n");

            // Generate image descriptions if present
            const imageDescriptions = [];
            if (tweet.photos?.length > 0) {
                elizaLogger.log("Processing images in tweet for context");
                for (const photo of tweet.photos) {
                    const description = await this.runtime
                        .getService<IImageDescriptionService>(
                            ServiceType.IMAGE_DESCRIPTION
                        )
                        .describeImage(photo.url);
                    imageDescriptions.push(description);
                }
            }

            // Handle quoted tweet if present
            let quotedContent = "";
            if (tweet.quotedStatusId) {
                try {
                    const quotedTweet =
                        await this.client.twitterClient.getTweet(
                            tweet.quotedStatusId
                        );
                    if (quotedTweet) {
                        quotedContent = `\nQuoted Tweet from @${quotedTweet.username}:\n${quotedTweet.text}`;
                    }
                } catch (error) {
                    elizaLogger.error("Error fetching quoted tweet:", error);
                }
            }

            // Compose rich state with all context
            const enrichedState = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: stringToUuid(
                        tweet.conversationId + "-" + this.runtime.agentId
                    ),
                    agentId: this.runtime.agentId,
                    content: { text: tweet.text, action: "" },
                },
                {
                    twitterUserName: this.twitterUsername,
                    currentPost: `From @${tweet.username}: ${tweet.text}`,
                    formattedConversation,
                    imageContext:
                        imageDescriptions.length > 0
                            ? `\nImages in Tweet:\n${imageDescriptions.map((desc, i) => `Image ${i + 1}: ${desc}`).join("\n")}`
                            : "",
                    quotedContent,
                }
            );

            // Generate and clean the reply content
            const replyText = await this.generateTweetContent(enrichedState, {
                template:
                    this.runtime.character.templates
                        ?.twitterMessageHandlerTemplate ||
                    twitterMessageHandlerTemplate,
            });

            if (!replyText) {
                elizaLogger.error("Failed to generate valid reply content");
                return;
            }

            if (this.isDryRun) {
                elizaLogger.info(
                    `Dry run: reply to tweet ${tweet.id} would have been: ${replyText}`
                );
                executedActions.push("reply (dry run)");
                return;
            }

            elizaLogger.debug("Final reply text to be sent:", replyText);

            let result;

            if (replyText.length > DEFAULT_MAX_TWEET_LENGTH) {
                result = await this.handleNoteTweet(
                    this.client,
                    this.runtime,
                    replyText,
                    tweet.id
                );
            } else {
                result = await this.sendStandardTweet(
                    this.client,
                    replyText,
                    tweet.id
                );
            }

            if (result) {
                elizaLogger.log("Successfully posted reply tweet");
                executedActions.push("reply");

                // Cache generation context for debugging
                await this.runtime.cacheManager.set(
                    `twitter/reply_generation_${tweet.id}.txt`,
                    `Context:\n${enrichedState}\n\nGenerated Reply:\n${replyText}`
                );
                this.numReplies++;
                await this.updateActionCounter("reply");
            } else {
                elizaLogger.error("Tweet reply creation failed");
            }
        } catch (error) {
            elizaLogger.error("Error in handleTextOnlyReply:", error);
        }
    }

    // Helper method to create memory for skipped tweets
    private async createSkippedTweetMemory(tweet: Tweet, roomId: UUID) {
        await this.runtime.ensureRoomExists(roomId);
        await this.runtime.ensureUserExists(
            stringToUuid(tweet.userId),
            tweet.username,
            tweet.name,
            "twitter"
        );
        await this.runtime.ensureParticipantInRoom(
            this.runtime.agentId,
            roomId
        );

        await this.runtime.messageManager.createMemory({
            id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
            userId: stringToUuid(tweet.userId),
            content: {
                text: tweet.text,
                url: tweet.permanentUrl,
                source: "twitter",
                action: "skipped",
            },
            agentId: this.runtime.agentId,
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: tweet.timestamp * 1000,
        });
    }

    // Helper method to create memory for processed tweets
    private async createProcessedTweetMemory(
        tweet: Tweet,
        roomId: UUID,
        executedActions: string[]
    ) {
        await this.runtime.ensureRoomExists(roomId);
        await this.runtime.ensureUserExists(
            stringToUuid(tweet.userId),
            tweet.username,
            tweet.name,
            "twitter"
        );
        await this.runtime.ensureParticipantInRoom(
            this.runtime.agentId,
            roomId
        );

        await this.runtime.messageManager.createMemory({
            id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
            userId: stringToUuid(tweet.userId),
            content: {
                text: tweet.text,
                url: tweet.permanentUrl,
                source: "twitter",
                action: executedActions.join(","),
            },
            agentId: this.runtime.agentId,
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: tweet.timestamp * 1000,
        });
    }

    private actionCounts: {
        [key: string]: { count: number; lastReset: number };
    } = {
        like: { count: 0, lastReset: Date.now() },
        retweet: { count: 0, lastReset: Date.now() },
        reply: { count: 0, lastReset: Date.now() },
        quote: { count: 0, lastReset: Date.now() },
    };

    private readonly ACTION_LIMITS = {
        like: { max: 8, windowHours: 3 },
        retweet: { max: 5, windowHours: 3 },
        reply: { max: 8, windowHours: 3 },
        quote: { max: 5, windowHours: 3 },
    };

    private canPerformAction(actionType: string): boolean {
        const now = Date.now();
        const actionState = this.actionCounts[actionType];
        const limit =
            this.ACTION_LIMITS[actionType as keyof typeof this.ACTION_LIMITS];

        if (!actionState || !limit) {
            return false;
        }

        // Reset counter if window has passed
        const windowMs = limit.windowHours * 60 * 60 * 1000;
        if (now - actionState.lastReset >= windowMs) {
            actionState.count = 0;
            actionState.lastReset = now;
        }

        return actionState.count < limit.max;
    }

    private async updateActionCounter(actionType: string): Promise<void> {
        const actionState = this.actionCounts[actionType];
        if (actionState) {
            actionState.count++;

            // Store the updated count in cache for persistence
            await this.runtime.cacheManager.set(
                `twitter/${this.twitterUsername}/action_counts/${actionType}`,
                {
                    count: actionState.count,
                    lastReset: actionState.lastReset,
                }
            );
        }
    }
}
