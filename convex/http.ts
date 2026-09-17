import { httpRouter } from "convex/server";
import { WebhookEvent } from "@clerk/nextjs/server";
import { Webhook } from "svix";
import { api } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

const http = httpRouter();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// ==========================================
// 1. CLERK WEBHOOK ROUTE
// ==========================================
http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new Error("Missing CLERK_WEBHOOK_SECRET environment variable");
    }

    const svix_id = request.headers.get("svix-id");
    const svix_signature = request.headers.get("svix-signature");
    const svix_timestamp = request.headers.get("svix-timestamp");

    if (!svix_id || !svix_signature || !svix_timestamp) {
      return new Response("No svix headers found", { status: 400 });
    }

    const payload = await request.json();
    const body = JSON.stringify(payload);

    const wh = new Webhook(webhookSecret);
    let evt: WebhookEvent;

    try {
      evt = wh.verify(body, {
        "svix-id": svix_id,
        "svix-timestamp": svix_timestamp,
        "svix-signature": svix_signature,
      }) as WebhookEvent;
    } catch (err) {
      console.error("Error verifying webhook:", err);
      return new Response("Error occurred", { status: 400 });
    }

    const eventType = evt.type;

    if (eventType === "user.created") {
      const { id, first_name, last_name, image_url, email_addresses } = evt.data;
      const email = email_addresses[0]?.email_address ?? "";
      const name = `${first_name || ""} ${last_name || ""}`.trim();

      try {
        await ctx.runMutation(api.users.syncUser, {
          email,
          name,
          image: image_url,
          clerkId: id,
        });
      } catch (error) {
        console.error("Error creating user:", error);
        return new Response("Error creating user", { status: 500 });
      }
    }

    if (eventType === "user.updated") {
      const { id, email_addresses, first_name, last_name, image_url } = evt.data;
      const email = email_addresses[0]?.email_address ?? "";
      const name = `${first_name || ""} ${last_name || ""}`.trim();

      try {
        await ctx.runMutation(api.users.updateUser, {
          clerkId: id,
          email,
          name,
          image: image_url,
        });
      } catch (error) {
        console.error("Error updating user:", error);
        return new Response("Error updating user", { status: 500 });
      }
    }

    return new Response("Webhooks processed successfully", { status: 200 });
  }),
});

// ==========================================
// 2. HELPER SANITIZERS
// ==========================================
function validateWorkoutPlan(plan: any) {
  return {
    schedule: Array.isArray(plan?.schedule) ? plan.schedule : ["Monday", "Wednesday", "Friday"],
    exercises: Array.isArray(plan?.exercises)
      ? plan.exercises.map((exercise: any) => ({
          day: exercise?.day || "Workout Day",
          routines: Array.isArray(exercise?.routines)
            ? exercise.routines.map((routine: any) => ({
                name: routine?.name || "Exercise",
                sets: typeof routine?.sets === "number" ? routine.sets : parseInt(routine?.sets, 10) || 3,
                reps: typeof routine?.reps === "number" ? routine.reps : parseInt(routine?.reps, 10) || 10,
              }))
            : [],
        }))
      : [],
  };
}

function validateDietPlan(plan: any) {
  return {
    dailyCalories:
      typeof plan?.dailyCalories === "number"
        ? plan.dailyCalories
        : parseInt(plan?.dailyCalories, 10) || 2000,
    meals: Array.isArray(plan?.meals)
      ? plan.meals.map((meal: any) => ({
          name: meal?.name || "Meal",
          foods: Array.isArray(meal?.foods) ? meal.foods : [],
        }))
      : [],
  };
}

// Clean markdown fences (e.g. ```json ... ```) that LLMs sometimes add
function cleanJsonText(rawText: string): string {
  return rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
}

// ==========================================
// 3. VAPI PLAN GENERATION ROUTE
// ==========================================
http.route({
  path: "/vapi/generate-program",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let toolCallId: string | undefined;

    try {
      const payload = await request.json();
      console.log("Incoming Vapi Payload:", JSON.stringify(payload, null, 2));

      // Handle Vapi tool-call payload nesting
      const message = payload?.message;
      const toolCall = message?.toolCalls?.[0] || message?.toolCallList?.[0];
      toolCallId = toolCall?.id;

      let rawArgs = toolCall?.function?.arguments || payload;
      if (typeof rawArgs === "string") {
        try {
          rawArgs = JSON.parse(rawArgs);
        } catch {
          rawArgs = {};
        }
      }

      // Resolve user_id across all possible Vapi object paths
      const userId =
        rawArgs?.user_id ||
        rawArgs?.userId ||
        payload?.user_id ||
        payload?.userId ||
        message?.variableValues?.user_id ||
        message?.call?.assistantOverrides?.variableValues?.user_id ||
        payload?.call?.assistantOverrides?.variableValues?.user_id;

      if (!userId) {
        console.error("Vapi payload FAILED: user_id missing. Payload:", payload);
        const errorResponse = {
          results: toolCallId
            ? [{ toolCallId, result: "Error: user_id was not provided." }]
            : undefined,
          error: "Missing required parameter: user_id.",
        };
        return new Response(JSON.stringify(errorResponse), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Extract user parameters with reasonable fallbacks
      const age = rawArgs?.age || "25";
      const height = rawArgs?.height || "175 cm";
      const weight = rawArgs?.weight || "70 kg";
      const injuries = rawArgs?.injuries || "None";
      const workout_days = rawArgs?.workout_days || "4";
      const fitness_goal = rawArgs?.fitness_goal || "Build muscle";
      const fitness_level = rawArgs?.fitness_level || "Intermediate";
      const dietary_restrictions = rawArgs?.dietary_restrictions || "None";

      const model = genAI.getGenerativeModel({
        model: "gemini-2.0-flash-001",
        generationConfig: {
          temperature: 0.3,
          topP: 0.9,
          responseMimeType: "application/json",
        },
      });

      // 1. Generate Workout Plan
      const workoutPrompt = `You are an experienced fitness coach creating a personalized workout plan based on:
Age: ${age}
Height: ${height}
Weight: ${weight}
Injuries or limitations: ${injuries}
Available days for workout: ${workout_days}
Fitness goal: ${fitness_goal}
Fitness level: ${fitness_level}

CRITICAL SCHEMA INSTRUCTIONS:
- Your output MUST contain ONLY the fields specified below, NO ADDITIONAL FIELDS
- "sets" and "reps" MUST ALWAYS be pure numbers (not strings).
- DO NOT use phrases like "To failure". Use a specific number (e.g. 10).

Return a JSON object with this EXACT structure:
{
  "schedule": ["Monday", "Wednesday", "Friday"],
  "exercises": [
    {
      "day": "Monday",
      "routines": [
        {
          "name": "Barbell Bench Press",
          "sets": 3,
          "reps": 10
        }
      ]
    }
  ]
}`;

      const workoutResult = await model.generateContent(workoutPrompt);
      const cleanedWorkoutText = cleanJsonText(workoutResult.response.text());
      const workoutPlan = validateWorkoutPlan(JSON.parse(cleanedWorkoutText));

      // 2. Generate Diet Plan
      const dietPrompt = `You are an experienced nutrition coach creating a personalized diet plan based on:
Age: ${age}
Height: ${height}
Weight: ${weight}
Fitness goal: ${fitness_goal}
Dietary restrictions: ${dietary_restrictions}

CRITICAL SCHEMA INSTRUCTIONS:
- Your output MUST contain ONLY the fields specified below, NO ADDITIONAL FIELDS
- "dailyCalories" MUST be a pure number.
- Each meal object should contain ONLY "name" and "foods" array.

Return a JSON object with this EXACT structure:
{
  "dailyCalories": 2200,
  "meals": [
    {
      "name": "Breakfast",
      "foods": ["3 eggs scrambled", "1 slice whole grain toast", "Black coffee"]
    },
    {
      "name": "Lunch",
      "foods": ["Grilled chicken breast", "Brown rice", "Steamed broccoli"]
    }
  ]
}`;

      const dietResult = await model.generateContent(dietPrompt);
      const cleanedDietText = cleanJsonText(dietResult.response.text());
      const dietPlan = validateDietPlan(JSON.parse(cleanedDietText));

      // 3. Persist to Convex Database
      const planId = await ctx.runMutation(api.plans.createPlan, {
        userId,
        dietPlan,
        workoutPlan,
        isActive: true,
        name: `${fitness_goal} Plan - ${new Date().toLocaleDateString()}`,
      });

      console.log(`Plan successfully created for user: ${userId} with ID: ${planId}`);

      // 4. Return appropriate Vapi Tool Call format
      const responsePayload = toolCallId
        ? {
            results: [
              {
                toolCallId,
                result: `Plan generated and saved successfully. Plan ID: ${planId}`,
              },
            ],
          }
        : {
            success: true,
            planId,
            workoutPlan,
            dietPlan,
          };

      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Error generating fitness plan:", error);

      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorResponse = toolCallId
        ? {
            results: [
              {
                toolCallId,
                result: `Failed to generate plan: ${errorMessage}`,
              },
            ],
          }
        : {
            success: false,
            error: errorMessage,
          };

      return new Response(JSON.stringify(errorResponse), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

export default http;