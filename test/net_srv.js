var house = require("../")();
var srv = require("http").createServer();
house.server(srv);

srv.on("request", function(req,res){
    if(req.url == "/kill") {
        res.end("Committing suicide...");
        process.exit(1);
    }
    res.end("Hey there. The time is: "+(new Date));
});
