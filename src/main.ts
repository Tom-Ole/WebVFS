import { Terminal } from '@xterm/xterm'
import './style.css'

let terminalElement = document.createElement('div')
terminalElement.id = 'terminal'



var term = new Terminal()
term.open(terminalElement)
term.write("Hello from \x1B[1;3;31mxterm.js\x1B[0m $ ")


document.querySelector<HTMLDivElement>('#app')!.append(terminalElement)

