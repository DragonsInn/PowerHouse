var cluster = require("cluster"),
    child_process = require("child_process"),
    net = require("net"),
    util = require("util"),
    cpus = require("os").cpus().length,
    ee = require("events").EventEmitter,
    path = require("path"),
    fs = require("fs"),
    ginga = require("ginga"),
    merge = require("merge"),
    async = require("async"),
    PrettyError = require("pretty-error"),
    pe = new PrettyError();

var debug = require("debug")("PowerHouse");

// External modules
var argv = require("yargs").argv;

// A basic wrapper
var PowerHouse = function PowerHouse(obj) {
    if(this instanceof PowerHouse) {
        ee.EventEmitter.call(this);
        this.procs = {};
        ginga.define("shutdown", function(ctx, n){
            var o = ctx.args[0];
            ctx.event = o.event;
            ctx.exitCode = 0;
            ctx.arguments = o.args;
            n();
        }, function(ctx, done){
            done(null, ctx);
        });
        this.addShutdownHandler = function(cb) {
            ginga.use("shutdown", cb);
        }
        this.doShutdownSequence = function(data, cb) {
            cb = cb || function(err,res){
                process.exit(0);
            };
            // There is no full use on this, yet. Will be extended another time.
            return ginga.shutdown(data,cb);
        }
        this.kill = function() {
            process.kill(process.pid);
        }
        this._sequenced = false;
        return this.init(obj);
    } else
        return new PowerHouse(obj);
}

util.inherits(PowerHouse,ee);

exports = module.exports = PowerHouse;

// Constants
PowerHouse.WORKER = "cluster";
PowerHouse.CHILD_PROCESS = "child";
PowerHouse.KILL_SIGNAL = "SIGINT";

// Defaults
var defaults = {
    title: "PowerHouse: Master",
    amount: cpus,
    workers: [],
    verbose: false,
    master: function(config, run){ /*run();*/ },
},
opts = defaults,
workerDefaults = {
    title: opts.title,
    reloadable: true,
    type: "cluster",
    isServer: false,
    listenArgs: []
};

// Utility
function resolve(file) {
    var pdir = path.dirname(module.parent.filename);
    var prel = path.join(pdir, file);
    if(fs.existsSync(prel)) {
        return prel;
    } else if(fs.existsSync(file)) {
        return file;
    } else {
        throw new Error("Unable to resolve file.");
    }
}

function make_worker(workerConf) {
    var proc;
    var processScript = require.resolve("./process");
    if(workerConf.type == "cluster") {
        proc = cluster.fork({
            POWERHOUSE_CONFIG: JSON.stringify(workerConf)
        });
    } else if(workerConf.type == "child") {
        var env = merge(process.env, {
            POWERHOUSE_CONFIG: JSON.stringify(workerConf)
        });
        proc = child_process.fork(processScript, ["--PowerHouse"], {
            env: env
        });
    }
    return proc;
}

// Events
// FIXME: worker.reload(worker)
// FIXME: worker.message(worker, message[, handle])
// FIXME: worker.shutdown()
// FIXME: master.shutdown(reason)
// FIXME: master.reconfigure(config)

function onMessageHandler(self, message, handle){
    var o=message;
    if(typeof o.ev == "undefined") return;
    debug("Received: %s",o.ev);
    // Emit the connection event to the specified server.
    // This will become a generic event if no server is set.
    // FIXME: Multiple port support. Actually, should this be made?
    if(o.ev=="PowerHouse::master.connection" && typeof self._child_srv != "undefined") {
        debug("Emitting on net server");
        return self._child_srv.emit("connection", handle);
    }

    // Generic events
    var matches = o.ev.match(/PowerHouse::(.+)/);
    if(matches != null) {
        var args = [];
        args.push(matches[1]);
        for(var l=0; l<o.args.length; l++) args.push(o.args[l]);
        args.push(handle);
        self._emit.apply(this, args);
    }
}

PowerHouse.prototype._isSetup = false;
function install_generic_handlers(exit_cb) {
    if(this._isSetup) return;
    var self = this;
    // Emitting is a bit different now
    var _emit = this.emit;
    this.emit = function() {
        var args = Array.prototype.slice.call(arguments);
        if(process.send) {
            debug("Sending '%s' from child", "PowerHouse::"+args[0]);
            var msg = {
                ev: "PowerHouse::"+args[0],
                args: args.slice(1)
            };
            process.send(msg);
        }
        return _emit.apply(self, arguments);
    }
    // Used to avoid emitting in an endless loop.
    self._emit = _emit;
    // Eventing across processes
    process.on("message", function(msg,hd){
        return onMessageHandler(self,msg,hd);
    });
    // Error and shutdowns
    var evs = ["exit","SIGINT","SIGBRK","SIGTERM"];
    evs.forEach(function(v,i){
        process.on(v, function(){
            debug("Process:"+v+" - Executing middlewares...");
            if(!self._sequenced) {
                self.doShutdownSequence({
                    event: v,
                    args: arguments
                }, exit_cb);
                self._sequenced = true;
            }
        });
    });
    // Avoid double calls
    this._isSetup=true;
}
function install_child_handlers(child, conf, index) {
    if(child._isSetup==true) return;
    debug("Installing child handles...");
    var self = this;
    var prefix = conf.type == "cluster" ? "Worker" : "Child";
    child.on("online", function(){
        debug("%s@%d is online", prefix, child.id || child.pid);
        self.emit("worker.start", child);
    });
    child.on("message", function(msg,hd){
        debug("%s@%s emitted: %s", prefix, child.id||child.pid, util.inspect(msg));
        return onMessageHandler(self,msg,hd);
    });
    child.on("exit",function(code,signal){
        debug("%s@%d exited (%d, %s)", prefix, child.id || child.pid, code, conf.exec);
        if(conf.reloadable) {
            // Revive this worker process.
            // FIXME: Send "offline" status to still open socket(s).
            debug("Reviving worker...");
            var proc =  make_worker(conf);
            install_child_handlers.call(self, proc, conf, index);
            self.procs[conf.title].children[index] = proc;
        } else {
            self.emit("worker.stop", child, code, signal);
        }
    });
    child.on("error", function(e){
        debug("%s@%d had an error", prefix, child.id || child.pid);
        self.emit("worker.error", child, e);
    });

    // Prevent double-calling
    child._isSetup = true;
}

PowerHouse.isMaster = PowerHouse.prototype.isMaster = function() {
    return cluster.isMaster && !("PowerHouse" in argv);
}
PowerHouse.isChild = PowerHouse.prototype.isChild = function() {
    return cluster.isWorker || ("PowerHouse" in argv);
}

PowerHouse.prototype.init = function(obj) {
    for(var k in obj) { opts[k]=obj[k]; }

    if(this.isMaster()) {
        // All can use this
        install_generic_handlers.bind(this)(opts.shutdown);
        // Master
        process.title = opts.title;
        var self = this;
        this.opts = opts;
        opts.master(opts, function(){ self.run.call(self); }, self);
    } else {
        // without finale cb
        install_generic_handlers.call(this);

        // Load the conf.
        var workerConf = JSON.parse(process.env.POWERHOUSE_CONFIG);
        if(workerConf.type == "cluster") {
            // A cluster module re-invokes the parent script.
            // That means that the original PowerHouse call is re-called, too.
            // A child_process.spawn'ed child however runs the process script
            // directly, so there is no need to do that here.
            require("./process");
        }
    }
}

PowerHouse.prototype.run = function() {
    var opts = this.opts;
    var workers = opts.workers;
    var initial = opts;
    delete initial[workers];

    for(var i in workers) {
        // Create defaults
        var workerConf = merge(workerDefaults, workers[i]);
        if(typeof workerConf.exec == "undefined") {
            throw new Error("Your worker config needs an exec property.");
        }
        debug("Launching: "+workerConf.exec);
        var children=[];
        workerConf.amount = workerConf.amount || initial.amount;
        workerConf.init = initial.init;

        // Make N workers
        for(var c=0; c<workerConf.amount; c++) {
            var proc = make_worker.call(this, workerConf);
            install_child_handlers.call(this, proc, workerConf, c);

            // Hofix for child_process.fork() ed modules. They don't emit "online".
            if(workerConf.type == "child") {
                debug("Child@%d is online", proc.id || proc.pid);
                this.emit("worker.start", proc);
            }

            // Make it exit friendly.
            proc._exited = false;
            proc._exitArgs = null;
            proc._group = workerConf.title;

            children[c]=proc;
        }

        // Create a net server if required
        var server = null;
        if(workerConf.isServer) {
            debug("Making a net server");
            server = net.createServer();
            server.on("connection", function(c){
                for(var n=0; n<children.length; n++) {
                    debug("Worker@%d got connection.", children[n].id || children[n].pid);
                    children[n].send({ev:"PowerHouse::master.connection",args:[]}, c);
                }
            });
            server.listen.apply(server, workerConf.listen);
        }

        this.procs[workerConf.title] = {
            children: children,
            config  : merge({}, workerConf),
            server  : server
        }
    }

    // Shutdown handlers
    var _shut = false;
    this.addShutdownHandler(function(ctx, next){
        if(_shut) return;
        _shut = true;
        debug("Processing exit...");
        // Merge all the children together.
        var allChildren = [];
        for(var id in this.procs) {
            var p = this.procs[id];
            p.children.forEach(function(c){
                // Trigger shutdown and add to list.
                var pid = (c.pid || c.process.pid);
                debug("Attempting to kill %s...", pid);
                c.on("exit", function(){
                    debug("Child@%s exited via .kill()", pid);
                }).kill(PowerHouse.KILL_SIGNAL);
                allChildren.push(c);
            });
        }

        // Make sure they all are gone.
        var allDone = false, list = {};
        var report = function() {
            debug("Still exiting... "+JSON.stringify(list));
            setTimeout(report, 500);
        }
        setTimeout(report, 1000);

        async.whilst(
            function Condition(){ return allDone != true; },
            function Body(proceed) {
                var allTrue = [], newChildren = []; list = {};
                allChildren.forEach(function(c, i, ref){
                    var c_pid = (c.pid || c.process.pid);
                    if(typeof c.isDead == "function") {
                        // Method 1: A worker process has .isDead().
                        c._exited = c.isDead();
                    } else if(typeof c._exited != "undefined") {
                        // Method 2: Try to test-kill
                        try {
                            process.kill(c_pid, 0);
                        } catch(e) {
                            // Target does not exist.
                            debug("Child %s was killed successfully", c_pid);
                            c._exited = true;
                        }
                    }
                    // Overwriting the other array
                    if(c._exited == false) {
                        newChildren.push(c);
                    }
                    list[c_pid] = [c._exited, c._group, c._exitCode];
                    allTrue.push(c._exited);
                });
                if(allTrue.length > 0) {
                    for(var i in allTrue) {
                        if(allTrue[i] == false) {
                            allDone = false;
                            break;
                        }
                    }
                } else {
                    // There are NO entries. It's safe to say...
                    debug("Array of truth is empty. allDone!");
                    allDone = true;
                }
                allChildren = newChildren;
                setTimeout(proceed, 100);
            },
            function onError(err) { next(err); }
        );
    }.bind(this));
}

PowerHouse.prototype.server = function(netServer) {
    // From now on, PowerHouse::master.connection is handled here.
    if(this.isMaster()) throw new Error("Only children should call this.");
    this._child_srv = netServer;
    this._child_srv.listen(-1);
}

PowerHouse.prototype.get = function(id) {
    return this.procs[id].config;
}

PowerHouse.prototype.set = function(id, config) {
    // FIXME: This should shut down all workers from this id and re-fork.
    this.procs[id].config = config;
    return 0;
}

PowerHouse.prototype.reconfigure = function(config) {
    // FIXME: Completely re-run PowerHouse.
    // Shutdown all workers, re-run().
    return 0;
}

PowerHouse.prototype.reload = function(id) {
    if(typeof id != "undefined") {
        // Relaunch all workers from this id
    } else {
        // Relaunch all workers
    }
}
