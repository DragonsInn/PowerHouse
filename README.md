# PowerHouse - because power plants are scaled too.

A single generator does not make enough power to satisfy a town, but many generators and such may do.

And a single node HTTP/S server doesn't satisfy all clients - but many, will.

There is the `cluster` module, yes. And it actually is really good. However - what if you want to use Socket.IO? The `sticky-session` module is a cluster-system by itself. So you can't fork your app, and then use that one also - and maybe you have a cluster module that utilizes hot-reloading (restarting your server on-demand). So all in all, It can be quite a clusterf**k. I have made the same experience, and I am done trying to mangle things right, here I present you my solution: the PowerHouse! And it packs more power than you could imagine - so how about a demo?

```javascript
var PowerHouse = require("powerhouse");
var house = PowerHouse({
    // This will become your master process' title
    title: "Master process",
    // The standard amount of workers to spawn
    amount: 1,
    // Be more verbose in logging. false by default
    verbose: false,
    // The function to run before setting up your stuff!
    master: function(config, run) {
        // config is this very configuration,
        // run is a function that starts the forking! Here's an example:
        getports(2, function(ports, err){
            global.ports = ports;
            run();
        });
    },
    // Configure your actual workers:
    workers: [
        {
            // A title for your worker process and amount.
            // However, there are options that do not have defaults.

            // The file to execute as worker
            exec: "./lib/worker.js",
            // Can this worker reload? Set to false to let the worker just die,
            // without resurrecting it. Useful ind evelopment to avoid error flooding.
            // Default is true.
            reloadable: true,
            // Do you want cluster.fork() style worker, or child_process.fork()?
            // Use either:
            //      - PowerHouse.WORKER or "cluster"
            //      - PowerHouse.CHILD_PROCESS or "child"
            // Default is WORKER.
            type: PowerHouse.WORKER,
            // Pass a config object to the worker. Default is an empty object.
            config: {},
            // If this is used, use sticky sessions on this worker. The listen-array
            // are arguments to be passed to the creation of the server.
            // It is recommended to attach the listening handler function inside
            // the **worker** process. The master process uses a regular net
            // server. It's sockets are passed to the responsible worker each
            // time a request is made. See more below.
            // Default is false.
            isServer: false,
            listen: [] // Not needed when above is false.
        }
    ]
});

// Events. Use PowerHouse.isMaster or assign inside PowerHouse.master
if(house.isMaster) {
    house.on("worker.start", function(worker){
        // Worker started
    });
    house.on("worker.stop", function(worker, signal, code){
        // A worker exited.
        // This worker object has a "worker.config" object attached.
        // It represents the config it was loaded with.
    });
}
```

## Installation
Your typical

    npm install powerhouse

## API
### Configuration within `PowerHouse()` (or `PowerHouse.init()`)
Many of the options are explaiend above already, but here is the entire and full list. The object is to be seen in two separate parts; the "initial" config that is anything but the `workers` property. And then the per-worker configuration.

#### Initial configuration
* `title`: Process title for the master process
* `amount`: The standard amount of workers to spawn. Defaults to: `require("os").cpus().length`
* `verbose`: More logging than usual.
* `master`: A callback to use when still on the master. It is called during initialization. The callback gets two parameters:
    - `config`: The initial config
    - `run`: This function triggers the actual initialization steps. Use this if you need heavy preparations for your code (finding ports, checking fiels and config, ...). Defaults to: `function(config,run){ run(); }`

#### Per-worker config
* `title`: Title for your worker process. Inherited from initial if not specified.
* `amount`: Amount of workers. Inherited from initial if not specified.
* `reloadable`: Reload this worker on exit/crash.
* `type`: Specify the type of worker.
    - `PowerHouse.WORKER`: This is the usual `cluster.fork()` kind of worker. it is tightly bound to the parent process and automatically invokes socket sharing. You can see the NodeJS docs on the `cluster` module.
    * `PowerHouse.CHILD_PROCESS`: Run your worker in an entirely new environment - its own NodeJS instance. It can be seen as a sub-master. It does **not** provide socket-sharing! To use it, you have to do a little bit of setup yourself. An example is below.
* `isServer`: If this is turned on, then PowerHouse knows of your worker being something like a HTTP server. This option turns on sticky connections. It emits an event to your worker and sends the socket upon connection. PowerHouse provides a shim to utilize this. An example below.
* `listen`: If the above is set to true, this is used on the `net.createServer().listen()` method as the arguments. Be aware that if you specify a listening handler here, it will only run once, on the master and will very likely not have access to some data you may want it to have access to.

### Events
PowerHouse doesn't just configure workers and sit there happily, it returns an instance that you can bind events to, run methods from and more! Following are the events you can listen on - they are represented as functions for this case.

* `worker.start(worker)`: A worker was started
* `worker.stop(worker, code, signal)`: Emitted every time a worker goes down.
* `worker.reload(worker)`: Triggered when a worker is reloaded on purpose.
* `worker.message(message[, handle])`: This is triggered if the worker uses `process.send()` or `cluster.send()`.
* `worker.shutdown(worker)`: Triggered when the worker is requested to shutdown.
* `master.shutdown(reason)`: Triggered when the master process is about to go down. `reason` is a string.
* `master.reconfigure(config)`: Sent to all workers when their config was updated.

### Methods
* `PowerHouse.init(Config)`: The equivalent of calling `PowerHouse(Config)`.
* `PowerHouse.run()`: This is the `run()` function passed to the callback in `Initial.master`. Yes, you don't have to actually start the clustering right there - it is up to you to leave out calling this function and waiting for something to happen before starting properly.
* `PowerHouse.get(id)`: Get a worker by it's ID. The ID being the title of the worker.
* `PowerHouse.set(id, config)`: re-configure the workers. Once this is done, the `master.reconfigure(config)` event is sent to the responsible workers.
* `PowerHouse.reload([id])`: Reload all reloadable workers. That involves making them shut down and restarting them. Passing an ID only restarts this group of workers.
* `PowerHouse.server(net compatible server)`: This server will be set up to get connections when using socket sharing.
* `PowerHouse.isMaster()`: Check if you are on the master process
* `PowerHouse.isWorker()`: Check if you are on the worker.

## Exiting
If you want to exit from the master process and want to make sure that all your workers exit cleanly, then please use:
- `PowerHouse.kill()`: Runs the shutdown handlers by SIGTERM'ing itself, then cleanly exits.

## Examples
### Basic example with 2 files, master.js and child.js
```javascript
// master.js
var house = require("powerhouse")({
    title: "MyApp",
    count: 1,
    workers: [{
        title: "MyApp Worker",
        exec: "./child.js",
        config: require("./package.json").config
    }]
});

// child.js
var mailer = require("some-mailer-module");
var redis = require("redis");
var sub = redis.createClient();
var pub = redis.createClient();
sub.on("message", function(channel, msg){ ... });
pub.publish("MyApp", {foo:"bar"});
```

### HTTP server
```javascript
// master.js
var house = require("powerhouse")({
    title: "MyApp",
    amount: 4,
    workers: [{
        title: "HTTP server",
        exec: "./child.js",
        config: {port: 9999}
    }]
});

// child.js
module.exports.run = function(config) {
    var bard = function(req,res){
        res.end("Whatever Baz said in Foo's bar; the little program never knew and just said 'Hello, world!'.");
    };

    // This function gets the config. Use it, if you want the config.
    // Does only work with clusters, not child_process'es.
    var server = require("http").createServer(bard);
    server.listen(config.port);

    // To use with express:
    var app = require("express")();
    app.get("/", bard);
    app.listen(config.port);
}
```

### Sticky HTTP
```javascript
// master.js
var PowerHouse = require("powerhouse");
var house = PowerHouse({
    title: "MyApp",
    amount: 4,
    workers: [{
        title: "HTTP server",
        exec: "./child.js",
        isServer: true,
        listen: [9999]
    }]
});

// child.js
var PowerHouse = require("powerhouse");
// Using Node HTTP
var http = require("http");
var server = http.createServer(...);
PowerHouse.server(server); // DO NOT .listen()! PowerHouse emits the listening event.
server.on("listening", ...);
// Using Express
var app = require("express")();
var server = require("http").createServer(app);
PowerHouse.server(server);
// Set up your routes like usual, or use the listening event.
// Express does not properly fire when using the "connection" event,
// which is used by this module to distribute sockets.
app.get("/", ...);
```

If you want to contribute an example, just PR it. :)


## Motivation
I was trying to make `sticky-session` work with Express and Socket.IO, had about four separate workers that just ran fine in a cluster - but my hTTP service needed to run in a separate child. It just got frustrating that the module I originally used didn't do the job right. So here I am - a solutiont hat hopefuly will work!


## Development

### Works:
- Spawning sub-processes via cluster.fork() and child_process.fork().
- Basic eventing.
- Processing configuration and creating workers and internal structure.
- Determining between Master and Worker/Child process.
- `PowerHouse.server()` doesnt exist yet, thus no socket forwarding
- Serious eventing between worker and child.

### Does not work yet:
- Keeping a child_process.fork()'ed module alive beyond its execution, just in case.
- `PowerHouse.reload()` isn't implemented yet.
