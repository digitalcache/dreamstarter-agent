import {
    IAgentRuntime,
    generateText,
    composeContext,
    ModelClass,
    generateObjectArray,
} from "@elizaos/core";
import { ClientBase } from "./base";
import { twitterPlanTemplate, twitterPostTemplate } from "./post";

export interface ScheduledPost {
    id: string;
    content: string;
    scheduledTime: Date;
    status: "draft" | "approved" | "rejected" | "posted";
    topics?: string[];
    notes?: string;
    reviewFeedback?: string;
}

export interface ContentPlan {
    id: string;
    startDate: Date;
    endDate: Date;
    posts: ScheduledPost[];
    status: "draft" | "in_review" | "approved" | "completed";
    metadata?: {
        totalPosts: number;
        topicDistribution?: { [key: string]: number };
        plannedTotalPosts: number;
    };
}

export class ContentPlanManager {
    private client: ClientBase;
    private runtime: IAgentRuntime;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
    }

    private calculatePostsPerDay(minInterval: number): number {
        const availableMinutes = 24 * 60;
        return Math.floor(availableMinutes / minInterval);
    }

    async generateContentPlan(
        startDate: Date,
        numberOfDays: number = 4,
        minInterval: number = 480
    ): Promise<ContentPlan> {
        const endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + numberOfDays);

        const planId = `plan-${startDate.getTime()}`;
        const postsPerDay = this.calculatePostsPerDay(minInterval);
        const initialPosts = await this.generateInitialPosts(
            startDate,
            10,
            minInterval
        );

        const contentPlan: ContentPlan = {
            id: planId,
            startDate,
            endDate,
            posts: initialPosts,
            status: "approved",
            metadata: {
                totalPosts: initialPosts.length,
                topicDistribution:
                    this.calculateTopicDistribution(initialPosts),
                plannedTotalPosts: numberOfDays * postsPerDay,
            },
        };
        await this.setActivePlan(contentPlan);
        await this.storePlan(contentPlan);
        return contentPlan;
    }

    async setActivePlan(plan: ContentPlan): Promise<void> {
        await this.runtime.cacheManager.set(
            `twitter/${this.client.profile.username}/active_plan`,
            plan.id
        );
    }

    private async generateInitialPosts(
        startDate: Date,
        count: number,
        minInterval: number
    ): Promise<ScheduledPost[]> {
        const state = await this.runtime.composeState(
            {
                userId: this.runtime.agentId,
                roomId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                content: {
                    text: this.runtime.character.topics.join(", "),
                    action: "TWEET",
                },
            },
            {
                twitterUserName: this.client.profile.username,
            }
        );

        const context = composeContext({
            state,
            template: twitterPlanTemplate
                .replace("%days%", "1")
                .replace("%num_per_day%", count.toString()),
        });

        const planData = await generateObjectArray({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        const posts: ScheduledPost[] = [];
        const currentDate = new Date(startDate);

        const now = new Date();
        if (currentDate < now) {
            currentDate.setTime(now.getTime());
        }

        planData.forEach((dayPlan, index) => {
            const postContent = dayPlan.content;
            const scheduledTime = new Date(currentDate);
            scheduledTime.setMinutes(
                scheduledTime.getMinutes() + index * minInterval
            );

            posts.push({
                id: `post-${scheduledTime.getTime()}-${Math.random().toString(36).substring(7)}`,
                content: postContent.text,
                scheduledTime,
                status: "approved",
                topics: this.extractTopics(postContent.text),
            });
        });

        return posts.sort(
            (a, b) =>
                new Date(a.scheduledTime).getTime() -
                new Date(b.scheduledTime).getTime()
        );
    }

    async generateNextPost(
        plan: ContentPlan,
        postInterval: number
    ): Promise<ScheduledPost | null> {
        if (!plan) return null;

        const lastPost = plan.posts[plan.posts.length - 1];
        if (!lastPost) return null;

        const now = new Date();
        let nextPostTime = new Date(lastPost.scheduledTime);
        nextPostTime.setMinutes(nextPostTime.getMinutes() + postInterval);

        // If the calculated next post time is in the past, use current time as base
        if (nextPostTime < now) {
            nextPostTime = new Date(now);
            nextPostTime.setMinutes(now.getMinutes() + postInterval);
        }

        if (nextPostTime > plan.endDate) return null;

        return await this.generatePost(nextPostTime);
    }

    private async generatePost(scheduledTime: Date): Promise<ScheduledPost> {
        console.log("Generating post for", scheduledTime);
        const state = await this.runtime.composeState(
            {
                userId: this.runtime.agentId,
                roomId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                content: {
                    text: this.runtime.character.topics.join(", "),
                    action: "TWEET",
                },
            },
            {
                twitterUserName: this.client.profile.username,
                scheduledTime: scheduledTime.toISOString(),
            }
        );

        const context = composeContext({
            state,
            template:
                this.runtime.character.templates?.twitterPostTemplate ||
                twitterPostTemplate,
        });

        const content = await generateText({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        return {
            id: `post-${scheduledTime.getTime()}-${Math.random().toString(36).substring(7)}`,
            content: this.cleanPostContent(content),
            scheduledTime,
            status: "approved",
            topics: this.extractTopics(content),
        };
    }

    private cleanPostContent(content: string): string {
        return content
            .replace(/^\s*{?\s*"text":\s*"|"\s*}?\s*$/g, "")
            .replace(/^['"](.*)['"]$/g, "$1")
            .replace(/\\"/g, '"')
            .replace(/\\n/g, "\n")
            .trim();
    }

    private extractTopics(content: string): string[] {
        // Extract topics based on character's defined topics and content analysis
        return this.runtime.character.topics.filter((topic) =>
            content.toLowerCase().includes(topic.toLowerCase())
        );
    }

    private calculateTopicDistribution(posts: ScheduledPost[]): {
        [key: string]: number;
    } {
        const distribution: { [key: string]: number } = {};
        posts.forEach((post) => {
            post.topics?.forEach((topic) => {
                distribution[topic] = (distribution[topic] || 0) + 1;
            });
        });
        return distribution;
    }

    async storePlan(plan: ContentPlan): Promise<void> {
        await this.runtime.cacheManager.set(
            `twitter/${this.client.profile.username}/content_plan/${plan.id}`,
            plan
        );
    }

    async getPlan(planId: string): Promise<ContentPlan | null> {
        return await this.runtime.cacheManager.get(
            `twitter/${this.client.profile.username}/content_plan/${planId}`
        );
    }

    async updatePost(
        planId: string,
        postId: string,
        updates: Partial<ScheduledPost>
    ): Promise<void> {
        const plan = await this.getPlan(planId);
        if (!plan) throw new Error("Plan not found");

        const postIndex = plan.posts.findIndex((p) => p.id === postId);
        if (postIndex === -1) throw new Error("Post not found");

        plan.posts[postIndex] = { ...plan.posts[postIndex], ...updates };
        await this.storePlan(plan);
    }

    async reviewPlan(
        planId: string,
        status: "approved" | "rejected",
        feedback?: string
    ): Promise<void> {
        const plan = await this.getPlan(planId);
        if (!plan) throw new Error("Plan not found");

        plan.status = status === "approved" ? "approved" : "draft";
        plan.posts.forEach((post) => {
            if (feedback) post.reviewFeedback = feedback;
        });

        await this.storePlan(plan);
    }
}
