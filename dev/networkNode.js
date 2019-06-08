const express = require('express')
const app = express()
const bodyParser = require('body-parser');
const Blockchain = require('./blockchain');
const uuid = require('uuid/v1');
const rp = require('request-promise');
const port = process.argv[2];

const nodeAddress = uuid().split('-').join('');

const bitcoin = new Blockchain();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false}));
 
app.get('/blockchain', function(req, res) {
  res.send(bitcoin);
})

app.get('/consensus', (req, res) => {
  const requestPromises = [];

  bitcoin.networkNodes.forEach(networkNodeUrl => {
    const requestOptions = {
      uri: networkNodeUrl + '/blockchain',
      method: 'GET',
      json: true
    }

    requestPromises.push(rp(requestOptions));
  });

  Promise.all(requestPromises).then(blockchains => {
    const currentChainLength = bitcoin.chain.length;
    let maxChainLength = currentChainLength;
    let newLongestChain = null;
    let newPendningTransaction = null;
    blockchains.forEach(blockchain => {
      if(blockchain.chain.length > maxChainLength){
        maxChainLength = blockchain.chain.length;
        newLongestChain = blockchain.chain;
        newPendningTransactions = blockchain.pendingTransactions;
      }
    });

    if(!newLongestChain || (newLongestChain && !bitcoin.chainIsValid(newLongestChain))){
      res.json({
        note: "current chain not replaced",
        chain: bitcoin.chain
      });
    }
    else if(newLongestChain && bitcoin.chainIsValid(newLongestChain)){
      bitcoin.chain = newLongestChain;
      bitcoin.pendingTransactions = newPendningTransactions;
      res.json({
        note: "this chain has been replaced",
        chain: newLongestChain
      });
    }
  });
});

app.post('/transaction', function(req, res){
	const blockIndex = bitcoin.addTransaction(req.body);
	res.json({ note: `Transaction will be added in block ${blockIndex}`});
});

app.post('/transaction/broadcast', function(req, res){
  const newTransaction = bitcoin.createNewTransaction(req.body.amount, req.body.sender, req.body.recipient);
  const blockIndex = bitcoin.addTransaction(newTransaction);

  const requestPromises = [];
  bitcoin.networkNodes.forEach(networkNodeUrl => {
    const requestOptions = {
      uri: networkNodeUrl + "/transaction",
      method: 'POST',
      body: newTransaction,
      json: true
    }

    requestPromises.push(rp(requestOptions));
  });

  Promise.all(requestPromises).then(data => {
    res.json({ note: "transaction created and broadcasted"});
  });
});

app.get('/mine', function(req, res){
  const lastBlock = bitcoin.getLastBlock();
  const previousBlockHash = lastBlock['hash'];
  const currentBlockData = {
    index: lastBlock['index'] + 1,
    transactions: bitcoin.pendingTransactions
  }
  const nonce = bitcoin.proofOfWork(previousBlockHash, currentBlockData);
  const blockHash = bitcoin.hashBlock(previousBlockHash, currentBlockData, nonce);

  bitcoin.createNewTransaction(12.5, "00", nodeAddress);

  const newBlock = bitcoin.createNewBlock(nonce, previousBlockHash, blockHash);

  const requestPromises = [];
  bitcoin.networkNodes.forEach(networkNodeUrl => {
    const requestOptions = {
      uri: networkNodeUrl + "/receive-new-block",
      method: "POST",
      body: { newBlock: newBlock },
      json: true
    }

    requestPromises.push(rp(requestOptions));
  })

  Promise.all(requestPromises).then(data => {
    const requestOptions = {
      uri: bitcoin.currentNodeUrl + "/transaction/broadcast",
      method: "POST",
      body: {
        amount: 12.5,
        sender: "00",
        recipient: nodeAddress
      },
      json: true
    }

    return rp(requestOptions);
  }).then(data => {
    res.json({
      note: "new block mined and broadcasted",
      block: newBlock
    });
  });
});

app.post('/receive-new-block', (req, res) => {
  const newBlock = req.body.newBlock;
  const lastBlock = bitcoin.getLastBlock();

  const correctHash = lastBlock.hash === newBlock.previousBlockHash;
  const correctIndex = lastBlock['index'] + 1 === newBlock['index'];

  if(correctHash && correctIndex){
    bitcoin.chain.push(newBlock);
    bitcoin.pendingTransactions = [];

    res.json({
      note: "new block received and accepted",
      newBlock: newBlock
    });
  }
  else{
    res.json({
      note: "new block rejected",
      newBlock: newBlock
    });
  }
});

app.get('/block/:blockHash', (req,res) => {
  const blockHash = req.params.blockHash;
  const correctBlock = bitcoin.getBlock(blockHash);

  res.json({
    block: correctBlock
  });
});

app.get('/transaction/:transactionId', (req,res) => {
  const transactionId = req.params.transactionId;
  const transactionData = bitcoin.getTransaction(transactionId);

  res.json({
    transaction: transactionData.transaction,
    block: transactionData.block
  });
});

app.get('/address/:address', (req,res) => {
  const address = req.params.address;
  const addressData = bitcoin.getAddressData(address);

  res.json({
    addressData: addressData
  })
});

app.get('/block-explorer', (req,res) => {
  res.sendFile('./block-explorer/index.html', {root: __dirname});
});

app.listen(port, function(){
  console.log(`Listening on port ${port}...`);
});

app.post('/register-and-broadcast-node', function(req, res){
  const newNodeUrl = req.body.newNodeUrl;
  if(bitcoin.networkNodes.indexOf(newNodeUrl) == -1 && newNodeUrl !== bitcoin.currentNodeUrl) 
    bitcoin.networkNodes.push(newNodeUrl);

  const regNodesPromises = [];
  bitcoin.networkNodes.forEach(networkNodeUrl => {
    const requestOptions = {
      uri: networkNodeUrl + '/register-node',
      method: 'POST',
      body: {newNodeUrl: newNodeUrl},
      json: true
    };

    regNodesPromises.push(rp(requestOptions));
  });

  Promise.all(regNodesPromises).then(data => {
    const bulkRegisterOptions = {
      uri: newNodeUrl + '/register-nodes-bulk',
      method: 'POST',
      body: { allNetworkNodes: [ ...bitcoin.networkNodes, bitcoin.currentNodeUrl]},
      json: true
    }

    return rp(bulkRegisterOptions);
  }).then( data => {
    res.json({ note: "new node registered"});
  })
});

app.post('/register-node', function(req, res){
  const newNodeUrl = req.body.newNodeUrl;
  const nodeNotAlreadyPresent = bitcoin.networkNodes.indexOf(newNodeUrl) == -1;
  const notCurrentNode = bitcoin.currentNodeUrl !== newNodeUrl;
  if(nodeNotAlreadyPresent && notCurrentNode) bitcoin.networkNodes.push(newNodeUrl);

  res.json({ note: "new node registered"});
});

app.post('/register-nodes-bulk', function(req, res){
  const allNetworkNodes = req.body.allNetworkNodes;
  allNetworkNodes.forEach(networkNodeUrl => {
    const nodeNotAlreadyPresent = bitcoin.networkNodes.indexOf(networkNodeUrl) == -1;
    const notCurrentNode = bitcoin.currentNodeUrl !== networkNodeUrl;
    if(nodeNotAlreadyPresent && notCurrentNode) bitcoin.networkNodes.push(networkNodeUrl);
  });

  res.json({ note: "bulk registered"});
});