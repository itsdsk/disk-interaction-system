const Handlebars = require('handlebars');
const fs = require('fs');
const path = require('path');
const net = require('net');

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(':memory:');

db.serialize(function () {
    // create tables for primitive types (disk and channel)
    db.run("CREATE TABLE disks (directory TEXT PRIMARY KEY, title TEXT, description TEXT, image BLOB, dat_key CHARACTER(64), dat_versions UNSIGNED SMALL INT)");
    db.run("CREATE TABLE channels (name TEXT PRIMARY KEY)");
    // create tables for relational types (files and connections)
    db.run("CREATE TABLE files (disk_directory TEXT NOT NULL, filename TEXT NOT NULL, data TEXT NOT NULL," +
        "FOREIGN KEY(disk_directory) REFERENCES disks(directory)," +
        "UNIQUE(disk_directory, filename))");
    db.run("CREATE TABLE connections (disk_directory TEXT NOT NULL, channel_name TEXT NOT NULL," +
        "FOREIGN KEY(disk_directory) REFERENCES disks(directory)," +
        "FOREIGN KEY(channel_name) REFERENCES channels(name)," +
        "UNIQUE(disk_directory, channel_name))");
    // add test data
    // db.run("INSERT INTO channels (name) VALUES ('channel2')");
    // db.run("INSERT INTO channels (name) VALUES ('channel3')");
});

// connect to engine
var backendSocket = new net.Socket();
backendSocket.connect(2845, function () {
    console.log("connected to engine");
});
backendSocket.on('error', function (err) {
    console.log('backend not connected:');
    console.log(err);
});


// compile media
var diskCompiler;
fs.readFile(path.join(__dirname, "templates", "disk.hbs"), function (err, data) {
    if (err) throw err;
    diskCompiler = Handlebars.compile(data.toString());
});
var channelCompiler;
fs.readFile(path.join(__dirname, "templates", "channel.hbs"), function (err, data) {
    if (err) throw err;
    channelCompiler = Handlebars.compile(data.toString());
});
var outputGraphicCompiler;
fs.readFile(path.join(__dirname, "templates", "output_graphic.hbs"), function (err, data) {
    if (err) throw err;
    outputGraphicCompiler = Handlebars.compile(data.toString());
});
var outputFormCompiler;
fs.readFile(path.join(__dirname, "templates", "output_form.hbs"), function (err, data) {
    if (err) throw err;
    outputFormCompiler = Handlebars.compile(data.toString());
});
var diskEditorCompiler;
fs.readFile(path.join(__dirname, "templates", "disk_editor.hbs"), function (err, data) {
    if (err) throw err;
    diskEditorCompiler = Handlebars.compile(data.toString());
});

var mediaDir = path.join(__dirname, 'disks');
var config; // device config
module.exports = {
    // build local database in memory
    generateDb: function () {
        // read media directory
        fs.readdir(mediaDir, function (err, files) {
            files.forEach(file => {
                var itemPath = path.join(mediaDir, file);
                fs.stat(itemPath, function (err, stats) {
                    if (err) console.log("err: " + err);
                    // check if subpath is a directory
                    if (stats.isDirectory()) {
                        // load media metadata
                        var meta = require(path.join(itemPath, 'demo.json'));
                        if (meta) {
                            // add to database
                            parseDiskDirectory(file, meta);
                        }
                    }
                });
            });
        });
        // get config JSON
        var configPath = path.join(__dirname, '..', 'renderer', 'config.json');
        try {
            config = require(configPath);
        } catch (ex) {
            console.log("Error getting config: " + ex);
            var pathToDefault = path.join(__dirname, '..', 'renderer', '.default', 'config.json');
            fs.copyFile(pathToDefault, configPath, (err) => {
                if (err) console.log(err)
                else {
                    console.log("Copied default config to " + configPath);
                    config = require(configPath);
                }
            });
        }
    },
    createDisk: function (channelName, callback) {
        // path of new disk
        var randomName = "disk_" + Math.random().toString(36).substring(2, 8);
        var newDirectory = path.join(mediaDir, randomName);
        console.log("USER INPUT::creating disk: " + newDirectory);
        // make directory
        fs.mkdir(newDirectory, function (err) {
            if (err) console.log(err)
            else {
                var pathToDefault = path.join(mediaDir, '.default');
                // get default metadata
                var meta = require(path.join(pathToDefault, 'demo.json'));
                // add channel if unique
                if (meta.demo.channels.indexOf(channelName) === -1)
                    meta.demo.channels.push(channelName);
                // save metadata to disk
                fs.writeFile(path.join(newDirectory, 'demo.json'), JSON.stringify(meta, null, 4), function (err) {
                    if (err) console.log(err);
                    // copy default files
                    fs.copyFile(path.join(pathToDefault, 'index.html'), path.join(newDirectory, 'index.html'), (err) => {
                        if (err) console.log(err);
                        fs.copyFile(path.join(pathToDefault, 'style.css'), path.join(newDirectory, 'style.css'), (err) => {
                            if (err) console.log(err);
                            fs.copyFile(path.join(pathToDefault, 'sketch.js'), path.join(newDirectory, 'sketch.js'), (err) => {
                                if (err) console.log(err);
                                fs.copyFile(path.join(pathToDefault, 'thumb.jpg'), path.join(newDirectory, 'thumb.jpg'), (err) => {
                                    if (err) console.log(err);
                                    // add to database
                                    parseDiskDirectory(randomName, meta, callback(randomName));

                                });
                            });
                        });
                    });
                });
            }
        });
    },
    listDatabase: function () {
        // log entries
        db.each("SELECT * FROM disks", function (err, row) {
            console.log("DISK: " + row.directory + " " + row.title + " " + row.description);
        });
        db.each("SELECT rowid AS id, disk_directory, filename FROM files", function (err, row) {
            console.log("FILE: " + row.disk_directory + " " + row.filename + " " + row.id);
        });
        db.each("SELECT * FROM channels", function (err, row) {
            console.log("CHANNEL: " + row.name);
        });
        db.each("SELECT * FROM connections", function (err, row) {
            console.log("CONNECTION: " + row.disk_directory + " " + row.channel_name);
        });
        db.each("SELECT * FROM outputs", function (err, row) {
            console.log("OUTPUT: " + JSON.stringify(row));
        });
        db.each("SELECT * FROM leds", function (err, row) {
            console.log("LED: " + JSON.stringify(row));
        });
    },
    createChannel: function (msg) {
        console.log("USER INPUT::creating channel: " + msg);
        var createQuery = "INSERT INTO channels (name) VALUES (?)";
        db.run(createQuery, [msg]);
    },
    updateFile: function (msg) {
        // update file in database
        var updateQuery = "UPDATE files SET data = ? WHERE rowid = ?";
        db.run(updateQuery, [msg.text, msg.fileID]);
        // get path of file on disk
        var filepath = path.join(mediaDir, msg.directory, msg.filename);
        console.log("USER INPUT::updating file " + filepath);
        // update file on disk
        fs.writeFile(filepath, msg.text, function (err) {
            if (err) console.log(err);
            // refresh window
            if (backendSocket.pending == false) {
                var updatedDir = 'file://' + path.join(mediaDir, msg.directory);
                backendSocket.write(updatedDir);
                console.log("refreshing " + updatedDir);
            }
        });
    },
    saveVersion: function (msg) {
        // update media DAT
        var Dat = require('dat-node');
        Dat(path.join(mediaDir, msg), function (err, dat) {
            if (err) throw err;
            dat.importFiles();
            dat.joinNetwork();
            console.log("USER INPUT::Saved revision " + dat.archive.version + " of " + msg + " in dat://" + dat.key.toString('hex'));
        });
        // TEST TO CHECKOUT AND DOWNLOAD OLD VERSION
        // Dat('/home/disk/ui/disks/item/', {
        //     key: '0c2f952a505a2bffc913a79e0fdc2cccf2654a31ff555dc6248a407036c69cd5'
        // }, function (err, dat) {
        //     if(err) throw err;
        //     dat.joinNetwork();
        //     dat.archive.on('content', function() {
        //         dat.archive.checkout(4).download('/', function (err) {
        //             if(err)console.log("err: " + err);
        //             dat.archive.readFile('/index.html', {cached: true}, function (err, content) {
        //                 if(err)console.log("err2: " + err);
        //                 console.log("content: " + content);
        //             });
        //         });
        //     });
        // });
    },
    deleteConnection: function (msg, callback) {
        console.log("USER INPUT::deleting connection: " + msg);
        // delete connection in database
        var sql = "DELETE FROM connections WHERE disk_directory = ? AND channel_name = ?";
        db.run(sql, msg);
        // get path and load json
        var metaPath = path.join(mediaDir, msg[0], 'demo.json');
        var meta = require(metaPath);
        // get index of channel in array
        var index = meta.demo.channels.indexOf(msg[1]);
        if (index > -1) {
            // delete if exists
            meta.demo.channels.splice(index, 1);
        }
        // save json to disk
        fs.writeFile(metaPath, JSON.stringify(meta, null, 4), function (err) {
            if (err) console.log(err);
            callback(msg[0]);
        });
    },
    createConnection: function (msg, callback) {
        console.log("USER INPUT::creating connection: " + msg);
        // create connection in database
        var sql = "INSERT INTO connections (disk_directory, channel_name) VALUES (?, ?)";
        db.run(sql, msg);
        // get path and load json
        var metaPath = path.join(mediaDir, msg[0], 'demo.json');
        var meta = require(metaPath);
        // get index of channel in array
        var index = meta.demo.channels.indexOf(msg[1]);
        if (index == -1) {
            // add if channel isnt connected
            meta.demo.channels.push(msg[1]);
        }
        // save json to disk
        fs.writeFile(metaPath, JSON.stringify(meta, null, 4), function (err) {
            if (err) console.log(err);
            callback(msg[0]);
        });
    },
    playLocalMedia: function (name) {
        var filePath = path.join(mediaDir, name);
        if (backendSocket.pending == false) {
            // send file path to engine if socket is connected
            backendSocket.write('file://' + filePath + "/index.html");
        }
        console.log('USER INPUT::playing local media: ' + filePath);
    },
    playRemoteMedia: function (name) {
        // TODO: check if URL is valid?
        if (backendSocket.pending == false) {
            // send file path to engine if socket is connected
            backendSocket.write(name);
            console.log('USER INPUT::playing remote media: ' + name);
        } else {
            console.log("USER INPUT::Cannot play " + name + " because renderer is disconnected");
        }
    },
    loadFeed: function (callback) {
        // get list of distinct disks in connections
        var selectQuery = "SELECT * FROM connections GROUP BY disk_directory";
        db.all(selectQuery, function (err, rows) {
            // group into channels
            var grouped = {};
            for (var i = 0; i < rows.length; i++) {
                if (grouped[rows[i].channel_name] == undefined) {
                    grouped[rows[i].channel_name] = [];
                }
                grouped[rows[i].channel_name].push(rows[i]);
            }
            // for each channel
            for (var key in grouped) {
                // skip loop of property is from prototype
                if (!grouped.hasOwnProperty(key)) continue;
                // 
                var obj = grouped[key];
                let disk_directories = obj.map(a => a.disk_directory);
                serveChannelAndDisks(key, disk_directories, function (element) {
                    console.log("USER INPUT::loading feed");
                    callback(element);
                });
            }
        });
    },
    loadEditor: function (directory, callback) {
        templateDisk(directory, diskEditorCompiler, function (elements) {
            console.log("USER INPUT::loading editor: " + directory);
            callback(elements);
        });
    },
    loadChannel: function (channel_name, callback) {
        var elements = "";
        // get channel element at start
        templateChannel(channel_name, true, function (channel_element) {
            elements = channel_element;
            // get all disks in specified channel
            var selectQuery = "SELECT disks.directory FROM disks INNER JOIN connections " +
                "ON disks.directory = connections.disk_directory " +
                "AND connections.channel_name = ?";
            db.all(selectQuery, [channel_name], function (err, rows) {
                // get disk PKs as array of strings
                let disk_directories = rows.map(a => a.directory);
                // 
                serveDiskArray(disk_directories, function (disk_elements) {
                    elements += disk_elements;
                    console.log("USER INPUT::loading feed for channel: " + channel_name);
                    callback(elements);
                });
            });
        });
    },
    loadOutput: function (callback) {
        var element = outputGraphicCompiler(config);
        element += "<br>" + outputFormCompiler(config);
        console.log("USER INPUT::loading output");
        callback(element);
    },
    updateConfig: function (msg) {
        console.log("USER INPUT::updating output configuration");
        // update window
        if (msg.window) {
            config.window = Object.assign(config.window, msg.window);
        }
        // update output
        if (msg.outputs) {
            // find correct output
            msg.outputs.forEach(function (msgoutput) {
                var output = config.outputs.find(x => x.index === msgoutput.index);
                // update output properties
                if (msgoutput.properties) {
                    output.properties = Object.assign(output.properties, msgoutput.properties);
                }
                // update output leds
                if (msgoutput.leds) {
                    // find correct led
                    msgoutput.leds.forEach(function (msgled) {
                        var led = output.leds.find(x => x.index === msgled.index);
                        // update led properties
                        led = Object.assign(led, msgled);
                    });
                }
            });
        }
    },
    uploadConfig: function (msg, callback) {
        console.log("USER INPUT::uploading output configuration");
        config = msg;
        callback();
    },
    saveConfig: function () {
        var configPath = path.join(__dirname, '..', 'renderer', 'config.json');
        console.log("USER INPUT::saving output config to " + configPath);
        fs.writeFile(configPath, JSON.stringify(config, null, 4), function (err) {
            if (err) console.log(err);
        });
    },
    getLogs: function (callback) {
        console.log("USER INPUT::getting service logs");
        runCommand('journalctl -u disk-backend-daemon.service -b --no-pager --lines=128', function (backendLogs) {
            runCommand('journalctl -u disk-renderer-daemon.service  -b --no-pager --lines=128', function (rendererLogs) {
                runCommand('journalctl -u disk-ui-daemon.service  -b --no-pager --lines=128', function (uiLogs) {
                    callback("backend: \n" + backendLogs + "renderer: \n" + rendererLogs + "ui: \n" + uiLogs);
                });
            });
        });
    },
    restartService: function (msg) {
        console.log("USER INPUT::restarting service " + msg);
        runCommand('systemctl restart ' + msg);
    },
    systemPower: function (msg) {
        console.log("USER INPUT::system " + msg);
        if (msg == "shutdown")
            runCommand('shutdown now');
        else if (msg == "reboot")
            runCommand('reboot');
    }
};

function serveChannelAndDisks(channel_name, disk_directories, callback) {
    var element = "";
    templateChannel(channel_name, false, function (channel_element) {
        element += channel_element;
        serveDiskArray(disk_directories, function (disk_elements) {
            element += disk_elements;
            callback(element);
        });
    });
}

function serveDiskArray(titles, callback) {
    var object = "";

    function repeat(title) {
        templateDisk(title, diskCompiler, function (element) {
            object += element;
            if (titles.length) {
                repeat(titles.pop());
            } else {
                callback(object);
            }
        });
    }
    repeat(titles.pop());
}

function templateChannel(channel_name, create_flag, callback) {
    // count number of disks in channel
    var countQuery = "SELECT channel_name, count(*) AS count FROM connections WHERE channel_name = ?";
    db.get(countQuery, [channel_name], (err, count) => {
        count.create = create_flag;
        var element = channelCompiler(count);
        callback(element);
    });
}

function templateDisk(disk_directory, templateCompiler, callback) {
    // fetch entry requested in [key] arg from disks table
    var sql = "SELECT directory, title, description, image FROM disks WHERE directory = ?";
    db.get(sql, [disk_directory], (err, itemrow) => {
        itemrow.files = new Array();
        // fetch corresponding entries in files table
        db.all("SELECT rowid AS id, disk_directory, filename, data FROM files WHERE disk_directory = ?", [disk_directory], function (err, filerows) {
            filerows.forEach(function (filerow) {
                // add each file to object
                itemrow.files.push(filerow);
            });
            // add arrays to hold channels
            itemrow.connectedChannels = new Array();
            itemrow.unconnectedChannels = new Array();
            // get channels
            var getChannelsQuery = "SELECT channels.name, connections.disk_directory FROM channels LEFT JOIN connections " +
                "ON channels.name = connections.channel_name " +
                "AND connections.disk_directory = ?";
            db.all(getChannelsQuery, [disk_directory], function (err, chanrows) {
                // loop through channels
                chanrows.forEach(function (chanrow) {
                    // check if channel is connected
                    if (chanrow.disk_directory) {
                        itemrow.connectedChannels.push(chanrow);
                    } else {
                        itemrow.unconnectedChannels.push(chanrow);
                    }
                });
                // compile media object into HTML and send to client websocket
                var element = templateCompiler(itemrow);
                callback(element);
            });
        });
    });
}

function parseDiskDirectory(directory, meta, callback) {
    // add metadata to disks table in database
    var insertQuery = "INSERT INTO disks (directory, title, description) VALUES (?, ?, ?)";
    db.run(insertQuery, [directory, meta.demo.title, meta.demo.description], function () {
        var itemPath = path.join(mediaDir, directory);
        if (meta.demo.image && meta.demo.image.length > 0) {
            // add image to disks database TODO: check if files exist
            var imagePath = path.join(itemPath, meta.demo.image);
            fs.readFile(imagePath, function (err, buf) {
                if (err) throw err;
                var decodedImage = "data:image/jpeg;base64," + buf.toString('base64');
                var addImgQuery = "UPDATE disks SET image = ? WHERE directory = ?";
                db.run(addImgQuery, [decodedImage, directory]);
            });
        }
        // add files to database
        var addFileQuery = "INSERT INTO files (disk_directory, filename, data) VALUES (?, ?, ?)";
        meta.demo.files.forEach(filename => {
            var filepath = path.join(itemPath, filename);
            fs.readFile(filepath, 'utf8', function (err, buf) {
                if (err) throw err;
                db.run(addFileQuery, [directory, filename, buf]);
            });
        });
        // add channels to database
        var addChannelQuery = "INSERT INTO channels (name) VALUES (?)";
        var addConnectQuery = "INSERT INTO connections (disk_directory, channel_name) VALUES (?, ?)";
        meta.demo.channels.forEach(channelName => {
            // add name to channels table
            db.run(addChannelQuery, [channelName], function () {
                // add pair to connections table
                db.run(addConnectQuery, [directory, channelName], callback);
            });
        });
    });

}

function runCommand(command, callback) {
    // run terminal command
    var exec = require('child_process').exec;
    exec(command, function (err, stdout, stderr) {
        if (err) {
            if(callback)callback(stderr);
        } else {
            if(callback)callback(stdout);
        }
    });
}