package main

import (
	"context"
	"fmt"

	"github.com/anthropics/anthropic-sdk-go"
)

func main() {
	client := anthropic.NewClient()
	ctx := context.Background()

	agent, err := client.Beta.Agents.New(ctx, anthropic.BetaAgentNewParams{
		Name: "Coding Assistant",
		Model: anthropic.BetaManagedAgentsModelConfigParams{
			ID: anthropic.BetaManagedAgentsModelClaudeOpus4_7,
		},
		System: anthropic.String("You are a helpful coding assistant. Write clean, well-documented code."),
		Tools: []anthropic.BetaAgentNewParamsToolUnion{{
			OfAgentToolset20260401: &anthropic.BetaManagedAgentsAgentToolset20260401Params{
				Type: anthropic.BetaManagedAgentsAgentToolset20260401ParamsTypeAgentToolset20260401,
			},
		}},
	})
	if err != nil {
		panic(err)
	}

	fmt.Printf("Agent ID: %s, version: %d\n", agent.ID, agent.Version)

	environment, err := client.Beta.Environments.New(ctx, anthropic.BetaEnvironmentNewParams{
		Name: "quickstart-env",
		Config: anthropic.BetaEnvironmentNewParamsConfigUnion{
			OfCloud: &anthropic.BetaCloudConfigParams{
				Networking: anthropic.BetaCloudConfigParamsNetworkingUnion{
					OfUnrestricted: &anthropic.BetaUnrestrictedNetworkParam{},
				},
			},
		},
	})
	if err != nil {
		panic(err)
	}

	fmt.Printf("Environment ID: %s\n", environment.ID)

	session, err := client.Beta.Sessions.New(ctx, anthropic.BetaSessionNewParams{
		Agent:         anthropic.BetaSessionNewParamsAgentUnion{OfString: anthropic.String(agent.ID)},
		EnvironmentID: environment.ID,
		Title:         anthropic.String("Quickstart session"),
	})
	if err != nil {
		panic(err)
	}

	fmt.Printf("Session ID: %s\n", session.ID)

	stream := client.Beta.Sessions.Events.StreamEvents(ctx, session.ID, anthropic.BetaSessionEventStreamParams{})
	defer stream.Close()

	// Send the user message after the stream opens
	_, err = client.Beta.Sessions.Events.Send(ctx, session.ID, anthropic.BetaSessionEventSendParams{
		Events: []anthropic.BetaManagedAgentsEventParamsUnion{{
			OfUserMessage: &anthropic.BetaManagedAgentsUserMessageEventParams{
				Type: anthropic.BetaManagedAgentsUserMessageEventParamsTypeUserMessage,
				Content: []anthropic.BetaManagedAgentsUserMessageEventParamsContentUnion{{
					OfText: &anthropic.BetaManagedAgentsTextBlockParam{
						Type: anthropic.BetaManagedAgentsTextBlockTypeText,
						Text: "Create a Python script that generates the first 20 Fibonacci numbers and saves them to fibonacci.txt",
					},
				}},
			},
		}},
	})
	if err != nil {
		panic(err)
	}

	// Process streaming events
loop:
	for stream.Next() {
		switch event := stream.Current().AsAny().(type) {
		case anthropic.BetaManagedAgentsAgentMessageEvent:
			for _, block := range event.Content {
				fmt.Print(block.Text)
			}
		case anthropic.BetaManagedAgentsAgentToolUseEvent:
			fmt.Printf("\n[Using tool: %s]\n", event.Name)
		case anthropic.BetaManagedAgentsSessionStatusIdleEvent:
			fmt.Print("\n\nAgent finished.\n")
			break loop
		}
	}
	if err := stream.Err(); err != nil {
		panic(err)
	}
}
