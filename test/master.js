var PowerHouse = require("../");

var house = PowerHouse({
    title: "o.o",
    amount: 1,
    master: function(conf, run) {
        console.log("-- Setting up...");
    },
    workers: [
        { // Cluster based process
            title: "o.o worker",
            exec: "./worker.js",
            reloadable: false
        },
        { // ChildProcess based process
            title: "o.o child",
            type: "child",
            exec: "./child.js",
            reloadable: false
        },
        {
            title: "o.o net",
            type: "child",
            exec: "./net_srv.js",
            reloadable: true,
            isServer: true,
            listen: [9999]
        }
    ]
});

if(PowerHouse.isMaster()) {
    house.on("worker.start", function(){
        console.log("-- A worker was started");
    });

    console.log(
        "Open http://localhost:9999 in your browser to see the current"
        +" time. Open http://localhost:9999/kill to have the server "
        +"exit and PowerHouse revive it immediately.\n\n"
        +"Run with DEBUG=PowerHouse:* set to see some debug infos."
    );
}

house.run();
