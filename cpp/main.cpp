#include <iostream>
#include <fstream>
#include <vector>
#include <climits>
#include <unistd.h>
#include <signal.h>
#include <chrono>

#include <device/DeviceManager.h>
#include <grabber/Image.h>
#include <grabber/ColorRgba.h>
#include <grabber/Grabber.h>

#include <boost/thread/thread.hpp>
#include <thirdparty/json/single_include/nlohmann/json.hpp>
#include <thirdparty/cxxopts/include/cxxopts.hpp>
#include <thirdparty/websocketpp/websocketpp/server.hpp>
#include <websocketpp/config/asio_no_tls.hpp>

#include <cstdio>
#include <boost/array.hpp>
#include <boost/bind.hpp>
#include <boost/enable_shared_from_this.hpp>
#include <boost/shared_ptr.hpp>
#include <boost/asio.hpp>

using boost::asio::local::stream_protocol;
using namespace std::chrono;

// time changing property
struct animatedProperty {
    unsigned int timeChanged = 0; // unix epoch time ms property was changed
    unsigned int fadeDuration = 1000; // transition duration in ms
    float initialValue = 0.0;
    float lastValue = 0.0;
    float targetValue = 0.0;
    void setTarget(float newTargetValue, unsigned int newFadeDuration = 1000) {
        // record current time
        timeChanged = duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
        // update values
        fadeDuration = newFadeDuration;
        initialValue = lastValue;
        targetValue = newTargetValue;
    }
    float getUpdatedValue(unsigned int currentms){
        // check if finished transitioning
        unsigned int elapsedTime = currentms - timeChanged;
        if (elapsedTime > fadeDuration) {
            // set prop to final value
            lastValue = targetValue;
        } else {
            // percent time passed
            float lerp_amt = float(elapsedTime) / float(fadeDuration);
            // interpolate value
            lastValue = initialValue + (lerp_amt * (targetValue - initialValue));
        }
        return lastValue;
    }
};

// signal/radius to change sampling radius for all LEDs
unsigned changeSize = 0;
unsigned int fadeDuration = 2500; // fade transition duration in ms
bool receivedScreenshotCommand = false;

// animated properties
animatedProperty browserWindowMix; // interpolate value: 0 = left screen, 1 = right
animatedProperty brightness;
animatedProperty desaturation; // 0.0 = normal colour, 1.0 = grayscale
animatedProperty gammaValue;

// logging
unsigned int performanceReadPeriod = 600;
unsigned int frameCount = 0;
unsigned int lastPerformanceRead = 0;

class session
    : public boost::enable_shared_from_this<session>
{
public:
    session(boost::asio::io_service &io_service)
        : socket_(io_service)
    {
    }

    stream_protocol::socket &socket()
    {
        return socket_;
    }

    void start()
    {
        // start listening for data to read on UNIX socket
        socket_.async_read_some(boost::asio::buffer(data_),
                                boost::bind(&session::handle_read,
                                            shared_from_this(),
                                            boost::asio::placeholders::error,
                                            boost::asio::placeholders::bytes_transferred));
    }

    void sendMessage(std::string message)
    {
        std::cout << "sending message: " << message << std::endl;
        boost::asio::async_write(socket_,
                                 boost::asio::buffer(message, message.length()),
                                 boost::bind(&session::handle_write,
                                             shared_from_this(),
                                             boost::asio::placeholders::error));
    }

    void handle_read(const boost::system::error_code &error,
                     size_t bytes_transferred)
    {
        if (!error)
        {
            std::string receivedData(data_.begin(), data_.begin() + bytes_transferred);
            // std::cout << "received data: " << receivedData << std::endl;
            // std::cout << "length: " << bytes_transferred << std::endl;
            // parse msg redeiced as json
            auto jdata = json::parse(receivedData);
            // go through top level of JSON object received
            for (auto &element1 : jdata.items())
            {
                string key1 = element1.key();
                if (key1 == "window")
                {
                    std::cout << "key1 is window" << std::endl;
                    if (element1.value().find("brightness") != element1.value().end())
                    {
                        // get brightness amt and update property
                        brightness.setTarget(element1.value()["brightness"].get<float>(), 1000);
                        std::cout << "user changing brightness to: " << brightness.targetValue << std::endl;
                    }
                    if (element1.value().find("blur") != element1.value().end())
                    {
                        // get size
                        changeSize = element1.value()["blur"].get<int>();
                        std::cout << "user changing blur size to: " << std::to_string(changeSize) << std::endl;
                    }
                    if (element1.value().find("fade") != element1.value().end())
                    {
                        // get size
                        fadeDuration = element1.value()["fade"].get<int>();
                        std::cout << "user changing fade to: " << std::to_string(fadeDuration) << std::endl;
                    }
                    if (element1.value().find("half") != element1.value().end())
                    {
                        // get browser window side and update property
                        browserWindowMix.setTarget(element1.value()["half"].get<float>(), fadeDuration);
                        std::cout << "user switching window side to " << browserWindowMix.targetValue << " with fade " << fadeDuration << std::endl;
                    }
                    if (element1.value().find("desaturation") != element1.value().end())
                    {
                        // get desaturation amt and update property
                        desaturation.setTarget(element1.value()["desaturation"].get<float>(), 1000);
                        std::cout << "user changing desaturation to: " << desaturation.targetValue << std::endl;
                    }
                    if (element1.value().find("gamma") != element1.value().end())
                    {
                        // get gammaValue amt and update property
                        gammaValue.setTarget(element1.value()["gamma"].get<float>(), 1000);
                        std::cout << "user changing gammaValue to: " << gammaValue.targetValue << std::endl;
                    }
                }
                else if (key1 == "command")
                {
                    cout << "key1 is command" << endl;
                    if (element1.value() == "screenshot")
                    {
                        cout << "screenshot" << endl;
                        receivedScreenshotCommand = true;
                    }
                }
            }
            // continue listening for data to read on UNIX socket
            socket_.async_read_some(boost::asio::buffer(data_),
                                    boost::bind(&session::handle_read,
                                                shared_from_this(),
                                                boost::asio::placeholders::error,
                                                boost::asio::placeholders::bytes_transferred));
        }
    }

    void handle_write(const boost::system::error_code &error)
    {
        if (!error)
        {
            //std::cout << "write without error" << std::endl;
            //   socket_.async_read_some(boost::asio::buffer(data_),
            //       boost::bind(&session::handle_read,
            //         shared_from_this(),
            //         boost::asio::placeholders::error,
            //         boost::asio::placeholders::bytes_transferred));
        }
    }

private:
    // The socket used to communicate with the client.
    stream_protocol::socket socket_;

    // Buffer used to store data received from the client.
    boost::array<char, 1024> data_;
};

typedef boost::shared_ptr<session> session_ptr;

class server1
{
public:
    server1(boost::asio::io_service &io_service, const std::string &file)
        : io_service_(io_service),
          acceptor_(io_service, stream_protocol::endpoint(file))
    {
        session_ptr new_session(new session(io_service_));
        acceptor_.async_accept(new_session->socket(),
                               boost::bind(&server1::handle_accept, this, new_session,
                                           boost::asio::placeholders::error));
    }

    void handle_accept(session_ptr new_session,
                       const boost::system::error_code &error)
    {
        if (!error)
        {
            new_session->start();
            std::cout << "client connected to UNIX socket" << std::endl;
        }

        currentSession = session_ptr(new_session);

        new_session.reset(new session(io_service_));
        acceptor_.async_accept(new_session->socket(),
                               boost::bind(&server1::handle_accept, this, new_session,
                                           boost::asio::placeholders::error));
    }

    void broadcast(std::string message)
    {
        if (currentSession.get() != nullptr)
        {
            std::cout << "sending broadcast msg" << std::endl;
            currentSession->sendMessage("broadcast!!!!");
        }
    }

private:
    session_ptr currentSession;
    boost::asio::io_service &io_service_;
    stream_protocol::acceptor acceptor_;
};

using namespace std;
using json = nlohmann::json;

// websocketpp
typedef websocketpp::server<websocketpp::config::asio> server;
using websocketpp::lib::placeholders::_1;
using websocketpp::lib::placeholders::_2;
typedef server::message_ptr message_ptr;

vector<DeviceManager> deviceManagers;
FrameGrabber *grabber;
unsigned _w;
unsigned _h;
bool receivedQuitSignal = false;

void on_message(server *s, websocketpp::connection_hdl hdl, message_ptr msg);

void saveScreenshot(Image<ColorRgba> &_image);

void exitHandler(int s);

int main(int argc, char *argv[])
{
    // ctrl-c (exit) signal handling
    struct sigaction sigIntHandler;
    sigIntHandler.sa_handler = exitHandler;
    sigemptyset(&sigIntHandler.sa_mask);
    sigIntHandler.sa_flags = 0;
    sigaction(SIGINT, &sigIntHandler, NULL);

    // command line options
    cxxopts::Options options("Disk", "Display Web Media on LEDs from Raspberry Pi");
    options.add_options()
        ("s,screenshot", "Save screenshot as .PPM")
        ("d,display", "Display screenshot on device")
        ("c,config", "Config file path", cxxopts::value<std::string>()->default_value("/home/pi/disk/config.json"))
        ("p,settings", "Settings file path", cxxopts::value<std::string>()->default_value("/home/pi/disk/settings.json"));
    auto result = options.parse(argc, argv);

    // read config file
    std::string confFilePath = result["c"].as<std::string>();
    std::cout << "Config file path: " << confFilePath << std::endl;
    std::ifstream confFile(confFilePath);
    json config;
    confFile >> config;
    // read settings file
    std::string settingsFilePath = result["p"].as<std::string>();
    std::cout << "Settings file path: " << settingsFilePath << std::endl;
    std::ifstream settingsFile(settingsFilePath);
    json settings;
    settingsFile >> settings;

    // unix sock server
    const char *sockPath = "/tmp/backend.sock";
    boost::asio::io_service io_service1;
    std::remove(sockPath);
    server1 s(io_service1, sockPath);
    boost::thread t1(boost::bind(&boost::asio::io_service::run, boost::ref(io_service1)));

    // websockets server
    server ws_server;
    boost::asio::io_service io_service;
    try
    {
        // todo: add exception handling e.g. https://mayaposch.wordpress.com/2015/09/16/creating-a-websocket-server-with-websocket/
        ws_server.init_asio(&io_service);
        ws_server.set_message_handler(bind(&on_message, &ws_server, ::_1, ::_2));
        ws_server.set_reuse_addr(true);
        ws_server.listen(9002);
        ws_server.start_accept();
        boost::thread t(boost::bind(&boost::asio::io_service::run, boost::ref(io_service)));
        cout << "WebSocket server listening on port 9002" << endl;
    }
    catch (websocketpp::exception const &e)
    {
        std::cout << e.what() << std::endl;
    }
    catch (...)
    {
        std::cout << "other exception" << std::endl;
    }

    // load settings from config file // TODO: check values exist in config
    changeSize = settings["blur"];
    fadeDuration = settings["fade"];

    // set animated props
    brightness.setTarget(settings["brightness"], 10000);
    desaturation.setTarget(settings["desaturation"], 1000);
    gammaValue.setTarget(settings["gamma"], 1000);

    // create framegrabber and image object
    _w = config["window"]["width"];
    _h = config["window"]["height"];
    cout << "config window size: " << _w << " x " << _h << endl;
    grabber = new FrameGrabber();
    Image<ColorRgba> _image(_w, _h);

    // add output objects based on config
    for (unsigned i = 0; i < config["outputs"].size(); i++)
    {
        deviceManagers.emplace_back(config, i, grabber->_width, grabber->_height);
    }

    //
    lastPerformanceRead = duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();

    // display screen on device
    while (receivedQuitSignal == false)
    {
        //s.broadcast("test broadcast");
        frameCount++;
        if (frameCount % performanceReadPeriod == 0) {
            unsigned int timeNow = duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
            unsigned int timeElapsed = timeNow - lastPerformanceRead; // ms
            float framerateNow = float(performanceReadPeriod) / float(timeElapsed);
            framerateNow *= 1000.0; // s
            cout << "FPS: " << framerateNow << endl;
            lastPerformanceRead = timeNow;
        }

        // should pixel sample radi change size
        if (changeSize > 0)
        {
            cout << "changing blur size: " << std::to_string(changeSize) << endl;
            // iterate over each device in manager
            for (int i = 0; i < deviceManagers.size(); i++)
            {
                // iterate over LEDs in device
                for (int k = 0; k < deviceManagers[i].ledNodes.size(); k++)
                {
                    // reset with new radius
                    deviceManagers[i].ledNodes[k].setPosition(deviceManagers[i].ledNodes[k].x_pos, deviceManagers[i].ledNodes[k].y_pos, changeSize, _w, _h, grabber->_width, grabber->_height);
                }
            }
            // complete signal
            changeSize = 0;
        }
        // grab frame
        grabber->grabFrame(_image);
        //
        if (receivedScreenshotCommand)
        {
            saveScreenshot(_image);
            receivedScreenshotCommand = false;
        }
        // get current time
        unsigned int currentms = duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
        // update properties
        browserWindowMix.getUpdatedValue(currentms);
        brightness.getUpdatedValue(currentms);
        desaturation.getUpdatedValue(currentms);
        gammaValue.getUpdatedValue(currentms);
        // update output devices
        for (auto &deviceManager : deviceManagers)
        {
            deviceManager.update(_image, brightness.lastValue, desaturation.lastValue, gammaValue.lastValue, browserWindowMix.lastValue);
        }
    }

    delete grabber;
    cout << "Exiting grabber" << endl;
    return 0;
}

void saveScreenshot(Image<ColorRgba> &_image)
{
    // write ppm file
    ofstream myfile;
    // TODO: make this relative
    myfile.open("/home/pi/disktime/public/screenshot.ppm");
    myfile << "P6"
           << "\n"
           << _image.width() << " " << _image.height() << "\n"
           << 255 << "\n";
    for (uint_least32_t y = 0; y < _image.height(); y++)
    {
        for (uint_least32_t x = 0; x < _image.width(); x++)
        {
            myfile << _image(x, y).red;
            myfile << _image(x, y).green;
            myfile << _image(x, y).blue;
        }
    }
    cout << "Saving screenshot" << endl;
    myfile.close();
}

void on_message(server *s, websocketpp::connection_hdl hdl, message_ptr msg)
{
    try
    {
        // parse msg received as json
        auto jdata = json::parse(msg->get_payload());
        //cout << "payload:" << jdata.dump(2) << endl;
        // go through top level of JSON object received
        for (auto &element1 : jdata.items())
        {
            string key1 = element1.key();
            if (key1 == "outputs")
            {
                // DEPRECATED

                /*
                // received an entry for "outputs", go through items in this array
                for (auto &element2 : (element1.value()).items())
                {
                    // get this output device index
                    if (element2.value().find("index") != element2.value().end())
                    {
                        int outputIndex = element2.value()["index"];
                        // look for LEDs in json
                        if (element2.value().find("leds") != element2.value().end())
                        {
                            // loop through objects in LEDs array
                            for (auto &ledElement : element2.value()["leds"].items())
                            {
                                // get new values for LED
                                int index = ledElement.value()["index"];
                                int x = ledElement.value()["x"];
                                int y = ledElement.value()["y"];
                                int r = ledElement.value()["r"];
                                // log
                                cout << "Received LED in device \"" << deviceManagers[outputIndex].nameTEMP << "\" at index " << index << " position " << x << "," << y << " r:" << r << endl;
                                // set led node position and radius
                                deviceManagers[outputIndex].ledNodes[index].setPosition(x, y, r, _w, _h, grabber->_width, grabber->_height);
                            }
                        }
                    }
                    else
                    {
                        cout << "could not get index" << endl;
                    }
                }
                */
            }
            else if (key1 == "command")
            {
                cout << "key1 is command" << endl;
                if (element1.value() == "screenshot")
                {
                    cout << "screenshot" << endl;
                    receivedScreenshotCommand = true;
                }
            }
        }
    }
    catch (const websocketpp::lib::error_code &e)
    {
        std::cout << "Read failed because: " << e << "(" << e.message() << ")" << std::endl;
    }
}

void exitHandler(int s)
{
    receivedQuitSignal = true;
}