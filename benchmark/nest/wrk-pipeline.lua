-- wrk script of benchmark/nest/main.mjs. Each connection sends the batch of
-- pipelined requests the runner passes as the script's argument, then its
-- next batch once every response to this one has arrived: wrk counts the
-- requests in the batch to know how many responses to wait for.
local batch

function init(args)
  batch = args[1]
end

function request()
  return batch
end

-- wrk's figures, as one JSON line after its own report
function done(summary)
  local errors = summary.errors
  io.write(string.format(
    '{"requests":%.0f,"durationUs":%.0f,"bytes":%.0f,"errors":{"connect":%.0f,"read":%.0f,"write":%.0f,"status":%.0f,"timeout":%.0f}}\n',
    summary.requests, summary.duration, summary.bytes, errors.connect,
    errors.read, errors.write, errors.status, errors.timeout))
end
