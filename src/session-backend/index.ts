import { Server, type Socket } from 'socket.io'
import type { Shape } from '../types'
import OpenAI from 'openai'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
if (!OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is not set in the environment')
}
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })
// Create an assistant
// In the tools parameter, I am supplying an array of tools with a specific JSON structure
const assistant = await openai.beta.assistants.create({
  instructions:
    'You are a helpful AI Assistant whose job is to help your users create and edit shapes on a canvas based on their instructions. The canvas is a 2D plane with an x and y axis. The y axis goes from negative (top) to positive (bottom). The x axis goes from negative (left) to positive (right). [0, 0] is in the middle of the screen',
  model: 'gpt-4-1106-preview',
  tools: getWhiteboardTools(),
})

// Create a thread for this user session
const thread = await openai.beta.threads.create()

// a function that starts a run and continues to poll until relevant tasks are executed or fail
async function handleUserPrompt(socket: Socket, message: string): Promise<void> {
  return new Promise(async (resolve, reject) => {
    // structure the message with context on the existing whiteboard.
    let messageWithContext = addMessageContext(message)

    // add a message to the thread
    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: messageWithContext,
    })
    // create a run to process the message
    activeRun = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: assistant.id,
    })

    let runResult: OpenAI.Beta.Threads.Runs.Run | undefined

    try {
      // get the run result
      runResult = await openai.beta.threads.runs.retrieve(thread.id, activeRun.id)

      const failedStatus = ['cancelled', 'failed', 'expired']
      if (failedStatus.includes(runResult?.status)) {
        activeRun = null
        socket.emit('updates', `Process failed with status: ${runResult.status}`)
        reject(new Error(`run result failed with status: ${runResult.status}`))
      }

      // while the run status is still in an accepted status, keep waiting for new status updates
      const pendingStatus = ['in_progress', 'queued', 'requires_action']
      while (pendingStatus.includes(runResult?.status)) {
        // poll the run every second if the run is still in progress
        if (runResult?.status === 'in_progress' || runResult?.status === 'queued') {
          socket.emit('updates', `Processing your request...`)
          await sleep(1000)
          if (activeRun) {
            runResult = await openai.beta.threads.runs.retrieve(thread.id, activeRun.id)
          }
          continue
        }

        const toolCalls = runResult?.required_action?.submit_tool_outputs.tool_calls ?? []
        const toolOutputs = toolCalls.map((call) => {
          const functionArgs = JSON.parse(call.function.arguments)
          const fn = functions[call.function.name]
          if (!fn) {
            socket.emit('updates', `Process encountered errors, restarting...`)
            console.error('function name did not match accepted function arguments')
            return {
              tool_call_id: call.id ?? '',
              output: 'error: couldnt find function',
            }
          }

          let fnStatus = ''
          // try calling the relevant function with arguments supplied by openai
          // if there is an error, update the output
          try {
            fn(functionArgs)
            fnStatus = 'Success. New shapes array: ' + JSON.stringify(shapes)
          } catch (err) {
            socket.emit('updates', `Process encountered errors, restarting...`)
            if (err instanceof Error) {
              fnStatus = err.toString()
            } else {
              fnStatus = 'unknown error occured'
            }
          }
          return {
            tool_call_id: call.id ?? '',
            output: `${fnStatus}`,
          }
        })

        if (activeRun) {
          // send the tool outputs to openai
          runResult = await openai.beta.threads.runs.submitToolOutputs(thread.id, activeRun.id, {
            tool_outputs: toolOutputs,
          })
        }
      }
      activeRun = null
      socket.emit('updates', '')
      resolve()
    } catch (error) {
      console.error('Error retrieving the run:', error)
      reject()
    }
  })
}

// Start a socket IO server that can be used to communicate between the client and server
const io = new Server(8080, { cors: { origin: '*' } })

// shapes holds the state of the whiteboard for a user session
let shapes: Shape[] = []

// users array holds the state of active users
const users: Set<{ id: string; socket: Socket }> = new Set()

// activeRun is a variable used to check whether new messages can be processed or if an active run is already in place
let activeRun: OpenAI.Beta.Threads.Runs.Run | null = null

io.on('connection', async (socket: Socket) => {
  console.log('New user connected:', socket.id)
  socket.emit('snapshot', shapes)
  const newUser = { id: socket.id, socket }
  users.add(newUser)

  // send all existing users a 'user-entered' event for the new user
  socket.broadcast.emit('user-entered', newUser.id)

  // send the new user a 'user-entered' event for each existing user
  for (const user of users) {
    newUser.socket.emit('user-entered', user.id)
  }

  // receive a user message. this is the prompt that we'll send to the openai assistant along with some context.
  socket.on('handle-user-prompt', async (message) => {
    if (activeRun === null) {
      // a function that polls the run status and executes relevant tasks
      await handleUserPrompt(socket, message)
    }
    // send updated shapes array to the client
    socket.emit('snapshot', shapes)
  })

  socket.on('create-shape', async (shape) => {
    shapes.push(shape)
    socket.broadcast.emit('snapshot', shapes)
  })

  socket.on('update-shape', (updatedShape) => {
    const shape = shapes.find((s) => s.id === updatedShape.id)
    if (!shape) return
    shape.x = updatedShape.x
    shape.y = updatedShape.y
    shape.w = updatedShape.w
    shape.h = updatedShape.h
    socket.broadcast.emit('update-shape', shape)
  })

  socket.on('cursor-position', ({ x, y }) => {
    socket.volatile.broadcast.emit('cursor-position', { id: socket.id, cursorX: x, cursorY: y })
  })

  socket.on('disconnect', () => {
    users.delete(newUser)
    socket.broadcast.emit('user-exited', newUser.id)
  })
})

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

// Whiteboard functions that the Assistant can call
function getWhiteboardTools(): OpenAI.Beta.Assistants.AssistantCreateParams.AssistantToolsFunction[] {
  return [
    {
      type: 'function',
      function: {
        name: 'createShape',
        description: 'Create a rectangle in a whiteboard',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'x position' },
            y: { type: 'number', description: 'y position' },
            w: { type: 'number', description: 'width of rectangle' },
            h: { type: 'number', description: 'height of rectangle' },
            color: {
              type: 'string',
              description: "hsl(_, _%, _%) if a color isn't specified, just use black.",
            },
          },
          required: ['x', 'y', 'w', 'h'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'editExistingShape',
        description:
          'Updates the properties for a shape given its id. For example, if the shape array looks like this [{id: 1234, x: 0, y: 0, color: `hsl(0, 0%, 0%)`}] and my user request is to move this shape to the left, I should return {id: 1234, x: -10}',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'the id of the existing shape to edit' },
            x: { type: 'number', description: 'x position' },
            y: { type: 'number', description: 'y position' },
            w: { type: 'number', description: 'width of rectangle' },
            h: { type: 'number', description: 'height of rectangle' },
            color: {
              type: 'string',
              description: "hsl(_, _%, _%) if a color isn't specified, just use black.",
            },
          },
          required: ['id'],
        },
      },
    },
  ]
}

// functions we call in pollRun depending on the required action by openai
const functions: Record<string, (toolOutput: any) => void> = {
  createShape(toolOutput: any) {
    if (
      !Number.isFinite(toolOutput?.x) ||
      !Number.isFinite(toolOutput?.y) ||
      !Number.isFinite(toolOutput?.w) ||
      !Number.isFinite(toolOutput?.h)
    ) {
      throw new Error('required params were not given')
    }
    // create a new shape and add it to the shapes array
    const generatedShape: Shape = {
      x: toolOutput.x,
      y: toolOutput.y,
      w: toolOutput.w,
      h: toolOutput.h,
      color: toolOutput?.color ?? `hsl(0, 0%, 0%)`,
      id: Math.floor(Math.random() * 100000),
    }
    shapes.push(generatedShape)
  },
  editExistingShape(toolOutput: any) {
    // find the shape to update based on id
    let editShape = shapes.find((shape) => shape.id === toolOutput.id)
    if (!editShape) {
      throw new Error('could not find shape')
    }
    // update the relevant parameters
    editShape.x = toolOutput?.x ?? editShape.x
    editShape.y = toolOutput?.y ?? editShape.y
    editShape.w = toolOutput?.w ?? editShape.w
    editShape.h = toolOutput?.h ?? editShape.h
    editShape.color = toolOutput?.color ?? editShape.color
  },
}

function addMessageContext(message: string): string {
  return `\
  This is the user's request:

  ${message}.

  These are the current shapes on the canvas:

  ${JSON.stringify(shapes, null, 2)}

  Remember, the y axis goes from negative (top) to positive (bottom). The x axis goes from negative (left) to positive (right). [0, 0] is in the middle of the screen.
  `
}
