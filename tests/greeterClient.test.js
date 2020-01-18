const path = require("path");
const grpc = require("grpc");
const GRPCError = require("grpc-error");
const protoLoader = require("grpc-pbf-loader").packageDefinition;
const { GrpcHostBuilder } = require("grpc-host-builder");
const { from, Observable, Subject } = require("rxjs");
const { map, reduce } = require("rxjs/operators");

const {
  HelloRequest: ServerUnaryRequest,
  HelloResponse: ServerUnaryResponse,
  SumResponse: ServerIngoingStreamingResponse,
  RangeRequest: ServerOutgoingStreamingRequest,
  RangeResponse: ServerOutgoingStreamingResponse,
  SelectResponse: ServerBidiStreamingResponse
} = require("./generated/server/greeter_pb").v1;
const {
  HelloRequest: ClientUnaryRequest,
  SumRequest: ClientOutgoingStreamingRequest,
  RangeRequest: ClientIngoingStreamingRequest,
  SelectRequest: ClientBidiStreamingRequest,
  GreeterClient
} = require("./generated/client/greeter_client_pb").v1;

grpc.setLogVerbosity(grpc.logVerbosity.ERROR + 1);

const grpcBind = "0.0.0.0:3000";
const packageObject = grpc.loadPackageDefinition(
  protoLoader.loadSync(path.join(__dirname, "./protos/greeter.proto"), {
    includeDirs: [path.join(__dirname, "../src/include/")]
  })
);

let server = null;
let client = null;

/**
 * Creates and starts gRPC server
 * @param {function(GrpcHostBuilder):GrpcHostBuilder} configurator Server builder configurator
 */
const createHost = configurator => {
  return configurator(new GrpcHostBuilder())
    .addService(packageObject.v1.Greeter.service, {
      sayHello: call => {
        const request = new ServerUnaryRequest(call.request);
        return new ServerUnaryResponse({
          spanId: call.metadata.get("span_id")[0],
          message: `Hello, ${request.name}!`
        });
      },
      sum: call =>
        call.source
          .pipe(
            reduce((acc, one) => {
              acc.result = acc.result + one.number;
              return acc;
            }, new ServerIngoingStreamingResponse({ result: 0 }))
          )
          .toPromise(),
      range: call => {
        const request = new ServerOutgoingStreamingRequest(call.request);
        return new Observable(subscriber => {
          for (let i = request.from; i <= request.to; i++)
            subscriber.next(new ServerOutgoingStreamingResponse({ result: i }));
          subscriber.complete();
        });
      },
      select: call => call.source.pipe(map(x => new ServerBidiStreamingResponse({ value: x.value + 1 })))
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
  server = createHost(x => x);

  // When
  const actualMessage = await getMessage("Tom");

  // Then
  expect(actualMessage).toBe("Hello, Tom!");
});

test("Must perform client streaming call", async () => {
  // Given
  server = createHost(x => x);
  client = new GreeterClient(grpcBind, grpc.credentials.createInsecure());
  const numbers = [1, 2, 3, 4, 5, 6, 7];

  // When
  const actualSum = (
    await client.sum(
      from(
        numbers.map(x => {
          const request = new ClientOutgoingStreamingRequest();
          request.setNumber(x);
          return request;
        })
      )
    )
  ).getResult();

  // Then
  const expectedSum = numbers.reduce((acc, one) => acc + one, 0);
  expect(actualSum).toBe(expectedSum);
});

test("Must perform server streaming call", async () => {
  // Given
  server = createHost(x => x);
  client = new GreeterClient(grpcBind, grpc.credentials.createInsecure());

  // When
  const rangeRequest = new ClientIngoingStreamingRequest();
  rangeRequest.setFrom(1);
  rangeRequest.setTo(3);

  const actualNumbers = [];
  await client.range(rangeRequest).forEach(x => actualNumbers.push(x.getResult()));

  // Then
  const expectedNumbers = [1, 2, 3];
  expect(actualNumbers).toEqual(expectedNumbers);
});

test("Must perform bidirectional streaming call", async () => {
  // Given
  server = createHost(x => x);
  client = new GreeterClient(grpcBind, grpc.credentials.createInsecure());

  // When
  const actualNumbers = [];
  const input = new Subject();
  const output = client.select(input);
  output.subscribe(message => {
    actualNumbers.push(message.getValue());

    if (message <= 5) {
      const request = new ClientBidiStreamingRequest();
      request.setValue(message.getValue() + 1);

      input.next(request);
    } else input.complete();
  });

  const firstRequest = new ClientBidiStreamingRequest();
  firstRequest.setValue(1);
  input.next(firstRequest);

  await output.toPromise();

  // Then
  const expectedNumbers = [2, 4, 6];
  expect(actualNumbers).toEqual(expectedNumbers);
});

test("Must receive error thrown in unary method implementation", async () => {
  // Given
  const mockLogger = { error: jest.fn() };
  const mockLoggersFactory = () => mockLogger;

  server = createHost(x =>
    x
      .addInterceptor(() => {
        throw new Error("Something went wrong");
      })
      .useLoggersFactory(mockLoggersFactory)
  );

  // When, Then
  await expect(getMessage("Tom")).rejects.toEqual(new Error("13 INTERNAL: Something went wrong"));
});

describe("Must handle client side errors during the client streaming call", () => {
  const testCases = [
    {
      toString: () => "Exception caused by calling subscriber's error method",
      messages: new Observable(subscriber => {
        subscriber.error(new Error("Something went wrong"));
      })
    },
    {
      toString: () => "Exception caused in Observable next method",
      messages: from([1]).pipe(
        map(x => {
          if (x === 1) throw new Error("Something went wrong");
        })
      )
    },
    {
      toString: () => "Exception caused in Observable constructor",
      messages: new Observable(subscriber => {
        throw new Error("Something went wrong");
      })
    }
  ];

  test.each(testCases)("%s", async testCase => {
    // Given
    server = createHost(x => x);
    client = new GreeterClient(grpcBind, grpc.credentials.createInsecure());

    // When, Then
    await expect(client.sum(testCase.messages)).rejects.toEqual(new Error("Something went wrong"));
  });
});

describe("Must handle client side errors during the bidirectional streaming call", () => {
  const testCases = [
    {
      toString: () => "Exception caused by calling subscriber's error method",
      messages: new Observable(subscriber => {
        subscriber.error(new Error("Something went wrong"));
      })
    },
    {
      toString: () => "Exception caused in Observable next method",
      messages: from([1]).pipe(
        map(x => {
          if (x === 1) throw new Error("Something went wrong");
        })
      )
    },
    {
      toString: () => "Exception caused in Observable constructor",
      messages: new Observable(subscriber => {
        throw new Error("Something went wrong");
      })
    }
  ];

  test.each(testCases)("%s", async testCase => {
    // Given
    server = createHost(x => x);
    client = new GreeterClient(grpcBind, grpc.credentials.createInsecure());

    // When, Then
    const output = client.select(testCase.messages);
    await expect(output.toPromise()).rejects.toEqual(new Error("Something went wrong"));
  });
});
