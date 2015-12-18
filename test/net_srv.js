var house = require("../")();
var srv = require("http").createServer();
try {
    house.server(srv);

    srv.on("request", function(req,res){
        if(req.url == "/kill") {
            res.end("Committing suicide...");
            process.exit(1);
        }
        res.end("Hey there. The time is: "+(new Date));
    });
    srv.listen(8000)
} catch(e) {
    console.log(e.stack)
}
