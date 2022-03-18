// This lets us serve our app's static asset without relying on any separate storage. (However, the space
// available for assets served this way is very limited; larger sites should continue to use Workers
// KV to serve assets.)
import HTML from "./index.html";

// `handleErrors()` is a little utility function that can wrap an HTTP request handler in a
// try/catch and return errors to the client. You probably wouldn't want to use this in production
// code but it is convenient when debugging and iterating.
async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") == "websocket") {
      // Annoyingly, if we return an HTTP error in response to a WebSocket request, Chrome devtools
      // won't show us the response body! So... let's send a WebSocket response with an error
      // frame instead.
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({error: err.stack}));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err.stack, {status: 500});
    }
  }
}

// `fetch` isn't the only handler. If your worker runs on a Cron schedule, it will receive calls
// to a handler named `scheduled`, which should be exported here in a similar way. We will be
// adding other handlers for other types of events over time.
export default {
  async fetch(request, env) {
    return await handleErrors(request, async () => {
      // We have received an HTTP request! Parse the URL and route the request.

      let url = new URL(request.url);
      let path = url.pathname // .slice(1).split('/');

      if (path === '' || path === '/') {
        // Serve our HTML at the root path.
        return new Response(HTML, {headers: {"Content-Type": "text/html;charset=UTF-8"}});
      } else if (path === '/ws') {
          // This is a request for `/api/...`, call the API handler.
          return handleApiRequest(request, env);
      } else {
          return new Response("Not found", {status: 404});
      }
    });
  }
}


async function handleApiRequest(request, env) {
  let url = new URL(request.url);
  let name = url.searchParams.get("room")
  console.log(`Room: ${name}`)
  let id;
  if (name.length <= 32) {
    // Treat as a string room name (limited to 32 characters). `idFromName()` consistently derives an ID from a string.
    id = env.rooms.idFromName(name);
  } else {
    return new Response("Name too long", {status: 404});
  }

  // Get the Durable Object stub for this room!
  let roomObject = env.rooms.get(id);

  // Send the request to the object. The `fetch()` method of a Durable Object stub has the
  // same signature as the global `fetch()` function, but the request is always sent to the
  // object, regardless of the request's URL.
  // return roomObject.fetch(url, request);
  return roomObject.fetch(request.url, request);
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function cardName(card) {
  const color = ["Red", "Yellow", "Green", "Blue"][card % 4]
  switch(true) {
    case (card >= 0 && card <= 39):
      return `${color} ${Math.floor(card/4)}`
    case (card >= 40 && card <= 43):
      return `${color} Skip`
    case (card >= 44 && card <= 47):
      return `${color} Reverse`
    case (card >= 48 && card <= 51):
      return `${color} Draw 2`
    case (card >= 52 && card <= 55):
      return "Wild"
    case (card >= 56 && card <= 59):
      return "Draw 4"
    default:
      return `CARD-${card}`
  }
}

function arrayLastN(arr, n) {
  if (arr.length <= n) {
    return arr
  }

  return arr.slice(arr.length - n, arr.length)
}

export class Deck {
  constructor(storage) {
    this.resetDeck()
    if (storage && false) {
      console.log(JSON.stringify(storage))
      this.discards = storage.discards
      this.hands = storage.hands
      this.players = storage.players
      this.history = storage.history
      this.current = storage.current
      this.direction = storage.direction
    } else {
      this.discards = [["",this.deck.pop()]]
      this.hands = {}
      this.players = []
      this.history = ["welcome"]
      this.current = 0
      this.direction = true
    }
  }

  toHash() {
    return {
      discards: this.discards,
      hands: this.hands,
      players: this.players,
      history: this.history,
      current: this.current,
      direction: this.direction
    }
  }

  sharedState() {
    return {
      discards: arrayLastN(this.discards, 5),
      lastPickup: [],
      history: this.history,
      current: this.players[this.current],
      direction: this.direction,
      players: this.players.map(n => [n, this.hands[n].length])
    }
  }

  resetDeck() {
    let deck = [0, 1, 2, 3] // 1 of each color zero
    for (let i = 4; i <= 39; i++) {
      deck = deck.concat([i, i]) // 2 of each color 1..9
    }
    for (let i = 40; i <= 51; i++) {
      deck = deck.concat([i, i, i]) // 3 of each color actions
    }
    deck = deck.concat([52, 52, 52, 52]) // 4 wilds
    deck = deck.concat([56, 56, 56, 56]) // 4 draw fours
    shuffle(deck)
    this.deck = deck
  }

  addHistory(txt) {
    this.lastPickup = []
    if (this.history.length > 4) {
      this.history = this.history.slice(this.history.length - 4, this.history.length)
    }
    this.history.push(txt)
  }

  addPlayer(name) {
    if (!this.hands[name]) {
      this.players = this.players.concat(name)
      this.hands[name] = this.deck.splice(-7, 7)
      this.hands[name].sort((a, b) => a - b)
      this.addHistory(`${name} picked up 7`)
    }
  }

  setCurrentPlayer(name) {
    let idx = this.players.findIndex(x => x === name)
    if (idx >= 0) {
      this.current = idx
    }
  }

  discard(name, card) {
    let idx = this.hands[name].findIndex(x => x === card)
    this.hands[name].splice(idx, 1)
    this.discards.push([name, card])
    if (card >= 44 && card <= 47) {
      this.direction = !this.direction
    }
    this.pass()
    if (card >= 40 && card <= 43) {
      this.pass() // Card was skip
    }
    this.addHistory(`${name} played a ${cardName(card)}`)
  }

  pass() {
    this.current = (this.players.length + this.current + (this.direction ? 1 : -1)) % this.players.length
  }

  pickup(name) {
    let card = this.deck.pop()
    this.hands[name].push(card)
    this.hands[name].sort((a,b) => a - b)
    if (this.lastPickup[0] === name) {
      this.lastPickup[1] += 1
      this.history[this.history.length - 1] = `${name} picked up ${this.lastPickup[1]}`
    } else {
      this.addHistory(`${name} picked up`)
      this.lastPickup = [name, 1]
    }
    return card
  }

  undiscard(name) {
    let [discardName, card] = this.discards.pop()
    this.hands[name].push(card)
    this.hands[name].sort((a,b) => a - b)
    this.addHistory(`${name} undid playing ${cardName(card)}`)
    return card
  }
}

// =======================================================================================
// The ChatRoom Durable Object Class
export class ChatRoom {
  constructor(controller, env) {
    // `controller.storage` provides access to our durable storage. It provides a simple KV get()/put() interface.
    this.storage = controller.storage;

    // We will put the WebSocket objects for each client, along with some metadata, into `sessions`.
    this.sessions = [];

    controller.blockConcurrencyWhile(async () => {
      let data = await this.storage.get('deck')
      console.log('read deck')
      console.log(data)
      if (data && data.length > 10) { data = JSON.parse(data) } else { data = null }
      this.deck = new Deck(data)
    })
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      // let url = new URL(request.url);
      if (request.headers.get("Upgrade") != "websocket") {
        return new Response("expected websocket", {status: 400});
      }

      let pair = new WebSocketPair();

      let url = new URL(request.url);
      let name = url.searchParams.get("uname")
      console.log(`Name: ${name}`)

      // We're going to take pair[1] as our end, and return pair[0] to the client.
      await this.handleSession(pair[1], name);

      // Now we return the other end of the pair to the client.
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }

  async handleSession(webSocket, name) {
    // Accept our end of the WebSocket.
    webSocket.accept();

    // Create our session and add it to the sessions list.
    let session = {webSocket, name};
    this.sessions.push(session);
    this.deck.addPlayer(name)

    // Set event handlers to receive messages.
    webSocket.addEventListener("message", async msg => {
      try {
        if (session.quit) {
          webSocket.close(1011, "WebSocket broken.");
          return;
        }
        this.deck.setCurrentPlayer(name)
        console.log(msg.data)
        let data = JSON.parse(msg.data);

        switch(data.cmd) {
          case "discard":
            this.deck.discard(name, data.data)
            if (this.deck.hands[name].length === 0) {
              this.broadcast(JSON.stringify({ cmd: "winner", data: name }))
            }
            break;
          case "pass":
            this.deck.pass(name)
            break
          case "pickup":
            const latestCard1 = this.deck.pickup(name)
            webSocket.send(JSON.stringify({cmd:"latest_card",data:latestCard1}))
            break
          case "reset":
            this.deck = new Deck()
            this.sessions.forEach(function(session, index) {
              session.quit = true
              session.webSocket.close(1011, "WebSocket broken.")
            })
            break
          case "undiscard":
            const latestCard2 = this.deck.undiscard(name)
            webSocket.send(JSON.stringify({ cmd: "latest_card", data: latestCard2 }))
            break
          default:
            console.log(`UNKNOWN COMMAND: ${data.cmd}`)
        }

        webSocket.send(JSON.stringify({ cmd: "state", data: { hand: this.deck.hands[name] } }))
        this.broadcast(JSON.stringify({ cmd: "state", data: this.deck.sharedState() }))

        // // Save message.
        // console.log(JSON.stringify(this.deck.toHash()))
        await this.storage.put('deck', JSON.stringify(this.deck.toHash()))
      } catch (err) {
        // Report any exceptions directly back to the client. As with our handleErrors() this
        // probably isn't what you'd want to do in production, but it's convenient when testing.
        webSocket.send(JSON.stringify({error: err.stack}));
      }
    });

    // On "close" and "error" events, remove the WebSocket from the sessions list and broadcast
    // a quit message.
    let closeOrErrorHandler = evt => {
      session.quit = true;
      this.sessions = this.sessions.filter(member => member !== session);
      if (session.name) {
        this.broadcast({quit: session.name});
      }
    };
    webSocket.addEventListener("close", closeOrErrorHandler);
    webSocket.addEventListener("error", closeOrErrorHandler);

    // Send first version of state
    webSocket.send(JSON.stringify({ cmd: "state", data: { hand: this.deck.hands[name] } }))
    this.broadcast(JSON.stringify({ cmd: "state", data: this.deck.sharedState() }))
  }

  // broadcast() broadcasts a message to all clients.
  broadcast(message) {
    // Apply JSON if we weren't given a string to start with.
    if (typeof message !== "string") {
      message = JSON.stringify(message);
    }

    // Iterate over all the sessions sending them messages.
    this.sessions = this.sessions.filter(session => {
      try {
        session.webSocket.send(message);
        return true;
      } catch (err) {
        session.quit = true;
        return false;
      }
    });
  }
}
