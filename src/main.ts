// FRONTEND with the help of AI (ChatGPT / Claude) [I dont want to do the frontend, want to focus on the VFS itself]

import { Terminal } from '@xterm/xterm'
import './style.css'
import { VFS } from './VFS'
import { IndexedDbDriver } from './StorageDriver'

let memoryDriver = new IndexedDbDriver()
let vfs = await VFS.create(memoryDriver)

let path = vfs.getCurrentPath()

function createColoredPrompt(): string {
  path = vfs.getCurrentPath()
  const ESC = String.fromCharCode(27) // ESC character
  return `${ESC}[31m${ESC}[1mUser: ${path} ${ESC}[97m${ESC}[0m- $ `
}

const PROMPT = () => createColoredPrompt()

enum Commands {
  HELP = 'help',
  ECHO = 'echo',
  CLEAR = 'clear',
  LS = 'ls',
  CD = 'cd',
  MKDIR = 'mkdir',
  TOUCH = 'touch',
}

interface Command {
  type: Commands
  args: string[]
}

// Setup terminal element and terminal
let terminalElement = document.createElement('div')
terminalElement.id = 'terminal'
document.querySelector<HTMLDivElement>('#app')!.append(terminalElement)

const term = new Terminal({
  cursorBlink: true,
  cols: 80,
  rows: 24,
  theme: {
    background: '#1a1a1a',
    foreground: '#ffffff',
    cursor: '#ffffff',
  },
  fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
  fontSize: 14,
})
term.open(terminalElement)

// Terminal state
let inputBuffer = ''
let history: string[] = []
let historyIndex = -1
let cursorPosition = 0 // Position within the input buffer

// Print prompt
function printPrompt() {
  term.write(PROMPT())
}

// Convert input string to command object with better validation
function stringToCommand(input: string): Command | null {
  const parts = input.trim().split(/\s+/)
  if (parts.length === 0 || parts[0] === '') {
    return null
  }

  let cmdString = parts[0].toLowerCase()

  // Check if command exists in enum
  const commandExists = Object.values(Commands).includes(cmdString as Commands)
  if (!commandExists) {
    term.write(`Unknown command: ${cmdString}`)
    term.write(`\r\nType 'help' for available commands.\r\n`)
    return null
  }

  let cmdType: Commands = cmdString as Commands
  const args = parts.slice(1)

  return { type: cmdType, args }
}

// Clear current input line on terminal
function clearInput() {
  // Clear the current input by moving cursor back and overwriting with spaces
  const promptLength = PROMPT().length
  term.write('\r' + ' '.repeat(promptLength + inputBuffer.length) + '\r' + PROMPT())
  cursorPosition = 0
}

// Redraw the current input line and position cursor correctly
function redrawInput() {
  // Move to beginning of line, clear it, write prompt and input
  const promptLength = PROMPT().length
  term.write('\r' + ' '.repeat(promptLength + inputBuffer.length) + '\r' + PROMPT() + inputBuffer)

  // Position cursor at the correct location
  const targetPosition = promptLength + cursorPosition
  const currentPosition = promptLength + inputBuffer.length
  const diff = currentPosition - targetPosition

  if (diff > 0) {
    // Move cursor left
    term.write('\x1b[' + diff + 'D')
  }
}

// Handle a command object and produce output
async function handleCommand(command: Command) {
  switch (command.type) {
    case Commands.HELP:
      term.write(
        'Available commands:\r\n' +
        '  help                    Show this help message\r\n' +
        '  echo <text>             Echo the text\r\n' +
        '  clear                   Clear the terminal\r\n' +
        '  ls [path]               List files in the directory (default is current)\r\n' +
        '  cd <path>               Change directory to the specified path\r\n' +
        '  mkdir <path>            Create a new directory at the specified path\r\n'
      )
      break

    case Commands.ECHO:
      if (command.args.length > 0) {
        // Handle basic escape sequences for better echo functionality
        let text = command.args.join(' ')
        text = text.replace(/\\n/g, '\r\n')
        text = text.replace(/\\t/g, '    ')
        term.write(text)
      }
      break

    case Commands.CLEAR:
      term.clear()
      printPrompt()
      return // Skip the normal newline + prompt flow

    case Commands.LS:
      if (command.args.length <= 1) {
        try {
          let list = vfs.ls(command.args[0])
          term.write(`List of ${command.args[0] || path}:\r\n`)
          list.forEach((entry) => {
            term.write(`${entry.name} (${entry.type})\r\n`)
          })
        } catch (error) {
          term.write(`${error instanceof Error ? error.message : 'Unknown error'}`)
        }
      } else {
        term.write('mkdir: too many arguments')
      }
      break

    case Commands.CD:
      // TODO: connect to VFS and change directory
      if (command.args.length === 1) {
        try {
          vfs.cd(command.args[0])
        } catch (error) {
          term.write(`${error instanceof Error ? error.message : 'Unknown error'}`)
        }
        break
      } else if (command.args.length === 0) {
        term.write('Usage: cd <path>')
      } else {
        term.write('cd: too many arguments')
      }
      break

    case Commands.MKDIR:
      // TODO: connect to VFS and create directory
      if (command.args.length === 1) {
        try {
          await vfs.mkdir(command.args[0])
          term.write(`Directory '${command.args[0]}' created successfully.`)
        } catch (error) {
          term.write(`${error instanceof Error ? error.message : 'Unknown error'}`)
        }
      } else if (command.args.length === 0) {
        term.write('Usage: mkdir <path>')
      } else {
        term.write('mkdir: too many arguments')
      }
      break

    case Commands.TOUCH:
      if (command.args.length === 1) {
        try {
          await vfs.touch(command.args[0])
          term.write(`File '${command.args[0]}' created successfully.`)
        } catch (error) {
          term.write(`${error instanceof Error ? error.message : 'Unknown error'}`)
        }
      } else if (command.args.length === 0) {
        term.write('Usage: touch <filename>')
      } else {
        term.write('touch: too many arguments')
      }
      break

    default:
      term.write(`Unknown command: ${command.type}`)
      break
  }

  // Only print newline and prompt if command didn't return early
  term.write('\r\n')
  printPrompt()
}

// Process the full input line string
function handleInput(input: string) {
  input = input.trim()
  if (input === '') {
    printPrompt()
    return
  }

  // Save to history & reset index
  history.push(input)
  historyIndex = history.length

  const cmd = stringToCommand(input)
  if (cmd) {
    handleCommand(cmd)
  } else {
    printPrompt()
  }
  inputBuffer = ''
  cursorPosition = 0
}

// Initialize terminal with prompt
term.write(PROMPT())

// Handle keyboard input data with improved character handling
term.onData((data) => {
  for (let i = 0; i < data.length; i++) {
    const char = data[i]
    const charCode = char.charCodeAt(0)

    // Skip escape sequences (arrow keys, etc.) - they're handled by onKey
    if (charCode === 27) { // ESC
      // Skip the entire escape sequence
      if (i + 2 < data.length && data[i + 1] === '[') {
        // Common escape sequence format: ESC[A, ESC[B, etc.
        i += 2 // Skip ESC and [
        while (i < data.length && data[i].match(/[0-9;]/)) {
          i++ // Skip numeric parameters
        }
        // Skip the final character of the sequence
        if (i < data.length) i++
        i-- // Adjust for the for loop increment
        continue
      }
    }

    switch (charCode) {
      case 13: // Enter (CR)
        term.write('\r\n')
        handleInput(inputBuffer)
        break
      case 8: // Backspace
      case 127: // Delete
        if (inputBuffer.length > 0 && cursorPosition > 0) {
          // Remove character at cursor position - 1
          inputBuffer = inputBuffer.slice(0, cursorPosition - 1) + inputBuffer.slice(cursorPosition)
          cursorPosition--
          redrawInput()
        }
        break
      case 12: // Ctrl+L (clear screen)
        term.clear()
        break
      default:
        // Only accept printable ASCII characters
        if (charCode >= 32 && charCode <= 126) {
          // Insert character at cursor position
          inputBuffer = inputBuffer.slice(0, cursorPosition) + char + inputBuffer.slice(cursorPosition)
          cursorPosition++
          redrawInput()
        }
    }
  }
})

// Handle arrow keys for history recall with improved navigation
term.onKey(({ domEvent }) => {
  // Always prevent default for arrow keys to stop escape sequences
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(domEvent.key)) {
    domEvent.preventDefault()
    domEvent.stopPropagation()
  }

  if (domEvent.key === 'ArrowUp') {
    if (history.length > 0 && historyIndex > 0) {
      historyIndex--
      clearInput()
      inputBuffer = history[historyIndex]
      cursorPosition = inputBuffer.length
      term.write(inputBuffer)
    }
  } else if (domEvent.key === 'ArrowDown') {
    if (history.length > 0 && historyIndex < history.length - 1) {
      historyIndex++
      clearInput()
      inputBuffer = history[historyIndex]
      cursorPosition = inputBuffer.length
      term.write(inputBuffer)
    } else if (historyIndex >= history.length - 1) {
      historyIndex = history.length
      clearInput()
      inputBuffer = ''
      cursorPosition = 0
    }
  } else if (domEvent.key === 'ArrowLeft') {
    // Move cursor left
    if (cursorPosition > 0) {
      cursorPosition--
      term.write('\x1b[1D') // Move cursor left one position
    }
  } else if (domEvent.key === 'ArrowRight') {
    // Move cursor right
    if (cursorPosition < inputBuffer.length) {
      cursorPosition++
      term.write('\x1b[1C') // Move cursor right one position
    }
  }
})