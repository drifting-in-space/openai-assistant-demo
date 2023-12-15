# openai-assistant-demo

![Assistant Demo Gif](https://github.com/drifting-in-space/openai-assistant-demo/assets/34881756/0a375c67-aa5f-406f-b31b-921896cf5dce)


A shared canvas built with the OpenAI Assistant, powered by Jamsocket's session backends.

## Tools you'll need

- [OpenAI API](https://platform.openai.com/docs/overview)
- [Jamsocket](https://jamsocket.com/)
- [Docker](https://www.docker.com/products/docker-desktop/)

## Setup

1. Clone the repo
2. [Create an account](https://app.jamsocket.com) on Jamsocket and create a service called `openai-assistant-demo`
3. Get an [OpenAI API key](https://platform.openai.com/docs/overview)
4. `cd` into the repo and `npm install`
5. Login to the Jamsocket CLI `npx jamsocket login`
6. Make sure Docker is running with `docker ps`

## Running the app

1. Spawn a backend with `npx jamsocket@latest dev`
2. Run the frontend with `npm run dev`
3. Navigate to `localhost:3000`

If you have any questions about how to use Jamsocket or would like to talk through your particular use case, we'd love to chat! Send us an email at [hi@driftingin.space](mailto:hi@driftingin.space)!
