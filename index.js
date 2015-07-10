var cluster = require("cluster"),
    child_process = require("child_process"),
    net = require("net"),
    util = require("util"),
    cpus = require("os").cpus().length,
    ee = require("events"),
    path = require("path"),
    fs = require("fs"),
    ginga = require("ginga"),
    merge = require("merge");

var debug = require("debug")("PowerHouse");

// External modules
var argv = require("yargs").argv;

// A basic wrapper
var PowerHouse = function PowerHouse(obj) {
    if(this instanceof PowerHouse) {
        ee.EventEmitter.call(this);
        this.procs = {};
        ginga.define("shutdown", function(ctx, done){
            process.exit(ctx.exitCode || 0);
            done(); // Won't be reached anyway.
        });
        this.addShutdownHandler = function(cb) {
            ginga.use("shutdown", cb);
        }
        this.doShutdownSequence = function(data) {
            // There is no full use on this, yet. Will be extended another time.
            return ginga.shutdown(data,function(err,res){});
        }
        return this.init(obj);
    } else
        return new PowerHouse(obj);
}

util.inherits(PowerHouse,ee);

exports = module.exports = PowerHouse;

// Constants
PowerHouse.WORKER = "cluster";
PowerHouse.CHILD_PROCESS = "child";

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
    if(workerConf.type == "cluster") {
        proc = cluster.fork({
            POWERHOUSE_CONFIG: JSON.stringify(workerConf)
        });
    } else if(workerConf.type == "child") {
        var env = merge(process.env, {
            POWERHOUSE_CONFIG: JSON.stringify(workerConf)
        });
        proc = child_process.fork(resolve(workerConf.exec), ["--PowerHouse"], {
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
function install_generic_handlers() {
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
    var evs = ["exit","SIGINT","SIGBRK"];
    evs.forEach(function(v,i){
        process.on(v, function(){
            self.doShutdownSequence({
                event: v,
                args: arguments
            });
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
        debug("%s@%d exited (%d)", prefix, child.id || child.pid, code);
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

    // All can use this
    install_generic_handlers.call(this);

    if(this.isMaster()) {
        // Master
        process.title = opts.title;
        var self = this;
        this.opts = opts;
        opts.master(opts, function(){ self.run.call(self); });
    } else {
        // Child. Execute!
        var workerConf = JSON.parse(process.env.POWERHOUSE_CONFIG);
        process.title = workerConf.title;
        this.emit("worker.started");
        if(workerConf.type == "cluster") {
            debug("Using cluster.fork()'ed worker.");
            var o = require(resolve(workerConf.exec));
            if("run" in o) o.run(workerConf);
        } else {
            // If the parent had a run method, we could runt his...
            debug("Using child_process.fork()'ed worker.");
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
        var children=[];
        workerConf.amount = workerConf.amount || initial.amount;

        // Make N workers
        for(var c=0; c<workerConf.amount; c++) {
            var proc = make_worker.call(this, workerConf);
            install_child_handlers.call(this, proc, workerConf, c);

            // Hofix for child_process.fork() ed modules. They don't emit "online".
            if(workerConf.type == "child") {
                debug("Child@%d is online", proc.id || proc.pid);
                this.emit("worker.start", proc);
            }

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
            config  : workerConf,
            server  : server
        }
    }
}

PowerHouse.prototype.server = function(netServer) {
    // From now on, PowerHouse::master.connection is handled here.
    if(this.isMaster()) throw new Error("Only children should call this.");
    this._child_srv = netServer;
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
