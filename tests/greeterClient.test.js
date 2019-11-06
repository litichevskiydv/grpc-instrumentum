const path = require("path");
const grpc = require("grpc");
const GRPCError = require("grpc-error");
const protoLoader = require("@grpc/proto-loader");
const { GrpcHostBuilder } = require("grpc-host-builder");
const {
  HelloRequest: ServerUnaryRequest,
  HelloResponse: ServerUnaryResponse
} = require("./generated/server/greeter_pb").v1;
const { HelloRequest: ClientUnaryRequest, GreeterClient } = require("./generated/client/greeter_client_pb").v1;

const grpcBind = "0.0.0.0:3000";
const packageObject = grpc.loadPackageDefinition(
  protoLoader.loadSync(path.join(__dirname, "./protos/greeter.proto"), {
    includeDirs: [path.join(__dirname, "../src/include/"), path.join(__dirname, "../node_modules/grpc-tools/bin/")]
  })
);

let server = null;
let client = null;

/**
 * Creates and starts gRPC server
 * @param {function(GrpcHostBuilder):GrpcHostBuilder} configurator Server builder configurator
 */
const createServer = configurator => {
  return configurator(new GrpcHostBuilder())
    .addService(packageObject.v1.Greeter.service, {
      sayHello: call => {
        const request = new ServerUnaryRequest(call.request);
        return new ServerUnaryResponse({ message: `Hello, ${request.name}!` });
      }
    })
    .bind(grpcBind)
    .build();
};

/**
 * @param {string} name
 * @returns {Promise<string>}
 */
const getMessage = async name => {
  const request = new ClientUnaryRequest();
  request.setName(name);

  client = new GreeterClient(grpcBind, grpc.credentials.createInsecure());
  return (await client.sayHello(request)).getMessage();
};

afterEach(() => {
  if (client) client.close();
  if (server) server.forceShutdown();
});

test("Must perform unary call", async () => {
  // Given
  server = createServer(x => x);

  // When
  const actualMessage = await getMessage("Tom");

  // Then
  expect(actualMessage).toBe("Hello, Tom!");
});

test("Must receive message composed by interceptors", async () => {
  // Given
  server = createServer(x =>
    x
      .addInterceptor(async (call, methodDefinition, callback, next) => {
        if (call.request.name === "Tom") callback(null, { message: "Hello again, Tom!" });
        else await next(call, callback);
      })
      .addInterceptor(async (call, methodDefinition, callback, next) => {
        if (call.request.name === "Jane") callback(null, { message: "Hello dear, Jane!" });
        else await next(call, callback);
      })
  );

  // When
  const messageForTom = await getMessage("Tom");
  const messageForJane = await getMessage("Jane");
  const messageForAlex = await getMessage("Alex");

  // Then
  expect(messageForTom).toBe("Hello again, Tom!");
  expect(messageForJane).toBe("Hello dear, Jane!");
  expect(messageForAlex).toBe("Hello, Alex!");
});

test("Must receive error", async () => {
  // Given
  const mockLogger = { error: jest.fn() };
  const mockLoggersFactory = () => mockLogger;

  server = createServer(x =>
    x
      .addInterceptor(() => {
        throw new Error("Something went wrong");
      })
      .useLoggersFactory(mockLoggersFactory)
  );

  // When, Then
  await expect(getMessage("Tom")).rejects.toEqual(new Error("13 INTERNAL: Something went wrong"));
});
