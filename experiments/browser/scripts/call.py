"""Call a browser tool on the selected local actor."""
import argparse
import json
from lab import client

parser=argparse.ArgumentParser()
parser.add_argument('tool')
parser.add_argument('arguments',nargs='?',default='{}')
args=parser.parse_args()
print(json.dumps(client().call(args.tool,json.loads(args.arguments)),indent=2))
